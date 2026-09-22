package org.betterreports;

import java.util.*;
import org.opensearch.OpenSearchStatusException;
import org.opensearch.action.support.PlainActionFuture;
import org.opensearch.commons.notifications.NotificationsPluginInterface;
import org.opensearch.commons.notifications.action.*;
import org.opensearch.commons.notifications.model.*;
import org.opensearch.core.rest.RestStatus;
import org.opensearch.core.xcontent.*;
import org.opensearch.common.xcontent.*;
import org.opensearch.core.common.bytes.BytesReference;
import org.opensearch.search.sort.SortOrder;
import org.opensearch.transport.client.node.NodeClient;

/** Uses the Notifications public transport API, including its access checks and keystore. */
final class NotificationsBridge {
    final BetterReportsPlugin.Service service;
    final NodeClient client;
    final NotificationsPluginInterface api = NotificationsPluginInterface.INSTANCE;
    NotificationsBridge(BetterReportsPlugin.Service service) { this.service = service; client = (NodeClient)service.client; }
    Map<String,Object> content(ToXContent value) throws Exception {
        try (XContentBuilder builder = XContentFactory.jsonBuilder()) {
            value.toXContent(builder, ToXContent.EMPTY_PARAMS);
            return service.parse(BytesReference.bytes(builder).utf8ToString());
        }
    }
    List<Map<String,Object>> configs(Set<String> ids, int from) throws Exception {
        PlainActionFuture<GetNotificationConfigResponse> future = new PlainActionFuture<>();
        api.getNotificationConfig(client, new GetNotificationConfigRequest(ids, from, 100, "name", SortOrder.ASC,
            ids.isEmpty() ? Map.of("config_type", "smtp_account,ses_account,email_group") : Map.of()), future);
        return (List<Map<String,Object>>)content(future.actionGet()).getOrDefault("config_list", List.of());
    }
    List<String> groups(Map<String,Object> input) {
        Object raw = input.get("recipientGroupIds");
        BetterReportsPlugin.Service.require(raw instanceof List<?> && !((List<?>)raw).isEmpty() && ((List<?>)raw).size() <= 50, "Select recipient groups");
        return ((List<?>)raw).stream().map(value -> { BetterReportsPlugin.Service.require(value instanceof String && !((String)value).isBlank() && ((String)value).length() <= 1000, "Invalid recipient group"); return (String)value; }).distinct().toList();
    }
    void validate(Map<String,Object> input) throws Exception {
        String sender = BetterReportsPlugin.Service.string(input, "senderId"); List<String> groups = groups(input);
        Set<String> ids = new HashSet<>(groups); ids.add(sender);
        List<Map<String,Object>> records = configs(ids, 0);
        Set<String> found = new HashSet<>(); int recipients = 0;
        for (Map<String,Object> record : records) {
            String id = (String)record.get("config_id"); Map<String,Object> config = (Map<String,Object>)record.get("config");
            BetterReportsPlugin.Service.require(Boolean.TRUE.equals(config.get("is_enabled")), "Selected Notifications configuration is disabled");
            String type = (String)config.get("config_type");
            if (id.equals(sender)) BetterReportsPlugin.Service.require(Set.of("smtp_account", "ses_account").contains(type), "Select an email sender");
            else {
                BetterReportsPlugin.Service.require(type.equals("email_group"), "Select email recipient groups");
                recipients += ((List<?>)((Map<?,?>)config.get("email_group")).get("recipient_list")).size();
            }
            found.add(id);
        }
        BetterReportsPlugin.Service.require(found.equals(ids), "Selected sender or recipient group is missing or inaccessible");
        BetterReportsPlugin.Service.require(recipients > 0 && recipients <= 50, "Recipient groups must contain between 1 and 50 addresses in total");
    }
    Object options(Map<String,Object> input) throws Exception {
        BetterReportsPlugin.Service.keys(input, "senderId", "recipientGroupIds");
        if (!input.isEmpty()) { validate(input); return Map.of("valid", true); }
        List<Object> senders = new ArrayList<>(), groups = new ArrayList<>();
        for (int from = 0; from < 10000; from += 100) {
            List<Map<String,Object>> records = configs(Set.of(), from);
            for (Map<String,Object> record : records) {
                Map<String,Object> config = (Map<String,Object>)record.get("config");
                if (!Boolean.TRUE.equals(config.get("is_enabled"))) continue;
                String type = (String)config.get("config_type");
                Map<String,Object> option = Map.of("id", record.get("config_id"), "label", config.get("name"));
                if (Set.of("smtp_account", "ses_account").contains(type)) senders.add(option);
                else if (type.equals("email_group")) groups.add(option);
            }
            if (records.size() < 100) return Map.of("senders", senders, "groups", groups);
        }
        throw new IllegalArgumentException("Too many Notifications configurations to list safely");
    }
    Object send(Map<String,Object> input) throws Exception {
        String channelId;
        String runId = BetterReportsPlugin.Service.string(input, "runId");
        String title = BetterReportsPlugin.Service.string(input, "subject");
        String filename = BetterReportsPlugin.Service.string(input, "filename");
        Object rawMessage = input.get("message"), rawPdf = input.get("pdf");
        BetterReportsPlugin.Service.require(rawMessage instanceof String && ((String)rawMessage).length() <= 10000, "Invalid message");
        BetterReportsPlugin.Service.require(title.length() <= 200 && !title.contains("\r") && !title.contains("\n"), "Invalid subject");
        BetterReportsPlugin.Service.require(filename.matches("[^/\\\\\r\n]{1,120}\\.pdf"), "Invalid PDF filename");
        BetterReportsPlugin.Service.require(rawPdf instanceof String && ((String)rawPdf).length() <= 34952536, "PDF exceeds 25 MiB");
        byte[] pdf = Base64.getDecoder().decode((String)rawPdf);
        BetterReportsPlugin.Service.require(pdf.length >= 5 && pdf.length <= 26214400 && new String(pdf, 0, 5, java.nio.charset.StandardCharsets.US_ASCII).equals("%PDF-"), "Invalid PDF");
        try {
            validate(input);
            Map<String,Object> config = Map.of("name", "BetterReports delivery " + runId, "description", "Temporary channel; removed after delivery", "config_type", "email", "is_enabled", true,
                "email", Map.of("email_account_id", input.get("senderId"), "email_group_id_list", groups(input), "recipient_list", List.of()));
            try (XContentParser parser = XContentType.JSON.xContent().createParser(service.registry, DeprecationHandler.THROW_UNSUPPORTED_OPERATION, service.json(Map.of("config", config)))) {
                parser.nextToken();
                PlainActionFuture<CreateNotificationConfigResponse> future = new PlainActionFuture<>();
                api.createNotificationConfig(client, CreateNotificationConfigRequest.parse(parser, null), future);
                channelId = future.actionGet().getConfigId();
            }
        } catch (Exception e) {
            throw new OpenSearchStatusException("NOTIFICATIONS_PREFLIGHT: Sender/groups must be accessible, enabled, and permitted for this report owner", RestStatus.FORBIDDEN, e);
        }
        try {
            service.active(service.get(BetterReportsPlugin.Service.string(input, "id")));
            PlainActionFuture<SendNotificationResponse> future = new PlainActionFuture<>();
            api.sendNotification(client, new EventSource(title, runId, SeverityType.INFO, List.of("BetterReports")),
                new ChannelMessage((String)rawMessage, null, new Attachment(filename, "base64", (String)rawPdf, "application/pdf")), List.of(channelId), future);
            future.actionGet();
            return Map.of("delivered", true);
        } finally {
            try {
                PlainActionFuture<DeleteNotificationConfigResponse> cleanup = new PlainActionFuture<>();
                api.deleteNotificationConfig(client, new DeleteNotificationConfigRequest(Set.of(channelId)), cleanup); cleanup.actionGet();
            } catch (Exception ignored) {
                org.apache.logging.log4j.LogManager.getLogger(NotificationsBridge.class).warn("betterreports temporary_notification_cleanup_failed channel={}", channelId);
            }
        }
    }
}
