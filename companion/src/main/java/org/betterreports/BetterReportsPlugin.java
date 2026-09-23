package org.betterreports;

import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.function.Supplier;
import org.opensearch.OpenSearchStatusException;
import org.opensearch.action.*;
import org.opensearch.action.admin.indices.create.CreateIndexRequest;
import org.opensearch.action.get.GetRequest;
import org.opensearch.action.delete.DeleteRequest;
import org.opensearch.action.index.IndexRequest;
import org.opensearch.action.search.SearchRequest;
import org.opensearch.action.support.*;
import org.opensearch.cluster.metadata.IndexNameExpressionResolver;
import org.opensearch.cluster.node.DiscoveryNodes;
import org.opensearch.cluster.service.ClusterService;
import org.opensearch.common.inject.Inject;
import org.opensearch.common.settings.*;
import org.opensearch.common.util.concurrent.ThreadContext;
import org.opensearch.core.action.ActionListener;
import org.opensearch.core.action.ActionResponse;
import org.opensearch.core.rest.RestStatus;
import org.opensearch.core.common.bytes.BytesReference;
import org.opensearch.core.common.io.stream.*;
import org.opensearch.core.xcontent.*;
import org.opensearch.common.xcontent.*;
import org.opensearch.env.*;
import org.opensearch.identity.PluginSubject;
import org.opensearch.indices.SystemIndexDescriptor;
import org.opensearch.plugins.*;
import org.opensearch.repositories.RepositoriesService;
import org.opensearch.rest.*;
import org.opensearch.script.ScriptService;
import org.opensearch.search.builder.SearchSourceBuilder;
import org.opensearch.index.query.QueryBuilders;
import org.opensearch.security.user.User;
import org.opensearch.security.support.ConfigConstants;
import org.opensearch.tasks.Task;
import org.opensearch.threadpool.ThreadPool;
import org.opensearch.transport.TransportService;
import org.opensearch.transport.client.Client;
import org.opensearch.transport.client.node.NodeClient;
import org.opensearch.watcher.ResourceWatcherService;

/** Exact 3.8.0 Security adapter. Never accepts identities or roles from REST input. */
public class BetterReportsPlugin extends Plugin implements ActionPlugin, SystemIndexPlugin, IdentityAwarePlugin {
    static final String INDEX = ".better-reports-grants-v1";
    static final String PREFIX = "cluster:admin/betterreports/";
    static final List<String> OPS = List.of("authorize", "execute", "check", "revoke", "list", "release", "invalidate", "notifications", "send");
    private Service service;
    public BetterReportsPlugin(Settings settings) {
        if (!settings.getAsBoolean("plugins.security.system_indices.enabled", false)) throw new IllegalStateException("BetterReports requires plugins.security.system_indices.enabled: true");
    }
    @Override public Collection<SystemIndexDescriptor> getSystemIndexDescriptors(Settings settings) {
        return List.of(new SystemIndexDescriptor(INDEX, "BetterReports durable execution grants"));
    }
    @Override public Collection<Object> createComponents(Client client, ClusterService cluster, ThreadPool pool,
        ResourceWatcherService watcher, ScriptService scripts, NamedXContentRegistry registry, Environment env,
        NodeEnvironment nodeEnv, NamedWriteableRegistry writes, IndexNameExpressionResolver resolver,
        Supplier<RepositoriesService> repositories) {
        service = new Service(client, pool, registry); return List.of(service);
    }
    @Override public void assignSubject(PluginSubject subject) { service.subject = subject; }
    @Override public List<ActionHandler<? extends ActionRequest, ? extends ActionResponse>> getActions() {
        return List.of(new ActionHandler<>(type("authorize"), Authorize.class), new ActionHandler<>(type("execute"), Execute.class),
            new ActionHandler<>(type("check"), Check.class), new ActionHandler<>(type("revoke"), Revoke.class), new ActionHandler<>(type("list"), ListGrants.class), new ActionHandler<>(type("release"), Release.class), new ActionHandler<>(type("invalidate"), Invalidate.class), new ActionHandler<>(type("notifications"), Notifications.class), new ActionHandler<>(type("send"), Send.class));
    }
    static ActionType<Reply> type(String op) { return new ActionType<>(PREFIX + op, Reply::new); }
    @Override public List<RestHandler> getRestHandlers(Settings settings, RestController controller, ClusterSettings clusterSettings,
        IndexScopedSettings indexSettings, SettingsFilter filter, IndexNameExpressionResolver resolver, Supplier<DiscoveryNodes> nodes) {
        return List.of(new Endpoint());
    }
    public static class Request extends ActionRequest {
        String json;
        Request(String json) { this.json = json; }
        Request(StreamInput in) throws IOException { super(in); json = in.readString(); }
        @Override public void writeTo(StreamOutput out) throws IOException { super.writeTo(out); out.writeString(json); }
        @Override public ActionRequestValidationException validate() { return null; }
    }
    public static class Reply extends ActionResponse {
        String json;
        Reply(String json) { this.json = json; }
        Reply(StreamInput in) throws IOException { super(in); json = in.readString(); }
        @Override public void writeTo(StreamOutput out) throws IOException { out.writeString(json); }
    }
    static class Endpoint extends BaseRestHandler {
        @Override public String getName() { return "better_reports_grants"; }
        @Override public List<Route> routes() { return OPS.stream().map(op -> new Route(RestRequest.Method.POST, "/_plugins/_better_reports/" + op)).toList(); }
        @Override protected RestChannelConsumer prepareRequest(RestRequest request, NodeClient client) throws IOException {
            if (request.content().length() > (request.path().endsWith("/send") ? 36 : 5) * 1024 * 1024) throw new IllegalArgumentException("Request too large");
            String op = request.path().substring(request.path().lastIndexOf('/') + 1);
            String json = request.hasContent() ? request.content().utf8ToString() : "{}";
            return channel -> client.execute(type(op), new Request(json), ActionListener.wrap(
                reply -> channel.sendResponse(new BytesRestResponse(RestStatus.OK, "application/json", reply.json)),
                error -> { try { channel.sendResponse(new BytesRestResponse(channel, error)); } catch (IOException ignored) {} }));
        }
    }
    public abstract static class Transport extends HandledTransportAction<Request, Reply> {
        final Service service; final String op;
        Transport(String op, TransportService transport, ActionFilters filters, Service service) {
            super(PREFIX + op, transport, filters, Request::new); this.service = service; this.op = op;
        }
        @Override protected void doExecute(Task task, Request request, ActionListener<Reply> listener) {
            service.pool.generic().execute(service.pool.getThreadContext().preserveContext(() -> {
                try { listener.onResponse(new Reply(service.json(service.handle(op, service.parse(request.json))))); }
                catch (Exception e) { listener.onFailure(e); }
            }));
        }
    }
    public static class Authorize extends Transport { @Inject public Authorize(TransportService t, ActionFilters f, Service s) { super("authorize", t, f, s); } }
    public static class Execute extends Transport { @Inject public Execute(TransportService t, ActionFilters f, Service s) { super("execute", t, f, s); } }
    public static class Check extends Transport { @Inject public Check(TransportService t, ActionFilters f, Service s) { super("check", t, f, s); } }
    public static class Revoke extends Transport { @Inject public Revoke(TransportService t, ActionFilters f, Service s) { super("revoke", t, f, s); } }
    public static class ListGrants extends Transport { @Inject public ListGrants(TransportService t, ActionFilters f, Service s) { super("list", t, f, s); } }
    public static class Notifications extends Transport { @Inject public Notifications(TransportService t, ActionFilters f, Service s) { super("notifications", t, f, s); } }
    public static class Send extends Transport { @Inject public Send(TransportService t, ActionFilters f, Service s) { super("send", t, f, s); } }
    public static class Release extends Transport { @Inject public Release(TransportService t, ActionFilters f, Service s) { super("release", t, f, s); } }
    public static class Invalidate extends Transport { @Inject public Invalidate(TransportService t, ActionFilters f, Service s) { super("invalidate", t, f, s); } }

    public static class Service {
        final Client client; final ThreadPool pool; final NamedXContentRegistry registry; PluginSubject subject;
        Service(Client client, ThreadPool pool, NamedXContentRegistry registry) { this.client = client; this.pool = pool; this.registry = registry; }
        Map<String,Object> parse(String text) throws IOException {
            try (XContentParser p = XContentType.JSON.xContent().createParser(registry, DeprecationHandler.THROW_UNSUPPORTED_OPERATION, text)) { return p.map(); }
        }
        String json(Object value) throws IOException { return BytesReference.bytes(XContentFactory.jsonBuilder().value(value)).utf8ToString(); }
        static void require(boolean condition, String message) { if (!condition) throw new OpenSearchStatusException(message, RestStatus.FORBIDDEN); }
        static String string(Map<String,Object> map, String key) { Object value = map.get(key); if (!(value instanceof String s) || s.isEmpty() || s.length() > 1000) throw new IllegalArgumentException("Invalid " + key); return s; }
        static void keys(Map<String,Object> input, String... allowed) { if (!Set.of(allowed).containsAll(input.keySet())) throw new IllegalArgumentException("Unexpected input fields"); }
        User actor() {
            User user = pool.getThreadContext().getTransient(ConfigConstants.OPENDISTRO_SECURITY_USER);
            require(user != null && !user.isPluginUser(), "Authenticated user required");
            String info = pool.getThreadContext().getTransient(ConfigConstants.OPENDISTRO_SECURITY_USER_INFO_THREAD_CONTEXT);
            require(info != null, "Authenticated role metadata required");
            String[] fields = info.split("(?<!\\\\)\\|", -1);
            require(fields.length >= 5 && fields[0].replace("\\|", "|").equals(user.getName()), "Invalid security context");
            return user.withSecurityRoles(Arrays.stream(fields[2].split(",")).filter(s -> !s.isEmpty()).map(s -> s.replace("\\|", "|")).toList());
        }
        void tenantAccess() {
            String info = pool.getThreadContext().getTransient(ConfigConstants.OPENDISTRO_SECURITY_USER_INFO_THREAD_CONTEXT);
            String[] fields = info.split("(?<!\\\\)\\|", -1);
            require(fields.length >= 5 && (fields[4].equals("READ") || fields[4].equals("WRITE")), "Tenant access required");
        }
        String tenant(User user) { return Objects.toString(user.getRequestedTenant(), ""); }
        <T> T internal(java.util.concurrent.Callable<T> fn) throws Exception {
            Object[] result = new Object[1]; subject.runAs(() -> result[0] = fn.call()); return (T)result[0];
        }
        void init() throws Exception {
            internal(() -> { if (!client.admin().indices().prepareExists(INDEX).get().isExists()) {
                try { client.admin().indices().create(new CreateIndexRequest(INDEX).settings(Settings.builder().put("index.hidden", true).put("number_of_shards", 1).put("auto_expand_replicas", "0-1"))
                    .mapping(Map.of("dynamic", false, "properties", Map.of("owner", Map.of("type", "keyword"), "tenant", Map.of("type", "keyword"), "reportId", Map.of("type", "keyword"))))).actionGet(); }
                catch (Exception e) { if (!e.getMessage().contains("resource_already_exists")) throw e; }
            } return null; });
        }
        Map<String,Object> get(String id) throws Exception {
            return internal(() -> { var r = client.get(new GetRequest(INDEX, id)).actionGet(); require(r.isExists(), "Grant unavailable"); return r.getSourceAsMap(); });
        }
        void active(Map<String,Object> grant) {
            require(!Boolean.TRUE.equals(grant.get("revoked")), "GRANT_REVOKED: Authorization has been revoked");
            if (Boolean.TRUE.equals(grant.get("runOnly"))) require(Instant.parse((String)grant.get("createdAt")).plusSeconds(86400).isAfter(Instant.now()), "Temporary run permission expired; generate the report again");
        }
        void ownerOrManager(Map<String,Object> grant, User actor) {
            require(Objects.equals(grant.get("tenant"), tenant(actor)), "Tenant mismatch");
            require(Objects.equals(grant.get("owner"), actor.getName()) || actor.getSecurityRoles().contains("betterreports_tenant_manager") || actor.getSecurityRoles().contains("all_access"), "Owner or tenant manager required");
        }
        Map<String,Object> summary(String id, Map<String,Object> g) {
            Map<String,Object> result = new LinkedHashMap<>(); for (String key : List.of("owner", "tenant", "reportId", "title", "revision", "createdAt", "revoked", "revokedAt", "revokedBy")) if (g.containsKey(key)) result.put(key, g.get(key));
            result.put("id", id); result.put("authorization", "until_revoked"); return result;
        }
        Object handle(String op, Map<String,Object> input) throws Exception {
            User caller = actor(); init();
            if (!Set.of("execute", "check", "release", "invalidate", "send").contains(op)) tenantAccess();
            if (op.equals("notifications")) return new NotificationsBridge(this).options(input);
            if (op.equals("authorize")) {
                keys(input, "reportId", "title", "persistent", "revision", "panels", "from", "to", "fingerprint");
                String reportId = string(input, "reportId"); String fingerprint = string(input, "fingerprint");
                require(input.get("revision") instanceof Number, "Revision required");
                Object raw = input.get("panels"); require(raw instanceof List<?> && ((List<?>)raw).size() <= 100, "Invalid panels");
                List<Map<String,Object>> panels = (List<Map<String,Object>>)raw;
                for (Map<String,Object> panel : panels) validatePanel(panel);
                // Validate queries in the live authenticated context before creating a durable grant.
                interval(input); for (Map<String,Object> panel : panels) search(panel, string(input, "from"), string(input, "to"));
                Map<String,Object> grant = new LinkedHashMap<>(); grant.put("owner", caller.getName()); grant.put("tenant", tenant(caller));
                grant.put("reportId", reportId); grant.put("revision", input.get("revision")); grant.put("fingerprint", fingerprint);
                if (input.containsKey("title")) grant.put("title", string(input, "title"));
                require(!input.containsKey("persistent") || input.get("persistent") instanceof Boolean, "Invalid persistence option");
                grant.put("runOnly", Boolean.FALSE.equals(input.get("persistent")));
                grant.put("panels", panels); grant.put("user", caller.toSerializedBase64());
                require(!caller.getSecurityRoles().isEmpty(), "No mapped execution roles available");
                grant.put("createdAt", Instant.now().toString()); grant.put("revoked", false);
                String id = UUID.randomUUID().toString(); internal(() -> client.index(new IndexRequest(INDEX).id(id).opType(DocWriteRequest.OpType.CREATE).source(grant).setRefreshPolicy(WriteRequest.RefreshPolicy.IMMEDIATE)).actionGet());
                org.apache.logging.log4j.LogManager.getLogger(Service.class).info("betterreports action=authorize grant={} owner={} tenant={}", id, caller.getName(), tenant(caller));
                return summary(id, grant);
            }
            if (op.equals("list")) {
                keys(input); var query = QueryBuilders.boolQuery().filter(QueryBuilders.termQuery("tenant", tenant(caller)));
                if (!caller.getSecurityRoles().contains("betterreports_tenant_manager") && !caller.getSecurityRoles().contains("all_access")) query.filter(QueryBuilders.termQuery("owner", caller.getName()));
                return internal(() -> { var result = client.search(new SearchRequest(INDEX).source(new SearchSourceBuilder().query(query).size(1000))).actionGet(); List<Object> list = new ArrayList<>(); for (var hit : result.getHits()) if (!Boolean.TRUE.equals(hit.getSourceAsMap().get("runOnly"))) list.add(summary(hit.getId(), hit.getSourceAsMap())); return Map.of("grants", list); });
            }
            keys(input, op.equals("send") ? new String[]{"id", "fingerprint", "senderId", "recipientGroupIds", "subject", "message", "runId", "filename", "pdf"} : op.equals("execute") ? new String[]{"id", "fingerprint", "from", "to"} : new String[]{"id", "fingerprint"});
            String id = string(input, "id"); Map<String,Object> grant = get(id);
            if (op.equals("release")) {
                require(Boolean.TRUE.equals(grant.get("runOnly")), "Only temporary run permissions can be released by workers");
                require(Objects.equals(input.get("fingerprint"), grant.get("fingerprint")), "Grant mismatch");
                internal(() -> client.delete(new DeleteRequest(INDEX, id).setRefreshPolicy(WriteRequest.RefreshPolicy.IMMEDIATE)).actionGet());
                return Map.of("released", true);
            }
            if (op.equals("invalidate")) {
                require(caller.getSecurityRoles().contains("betterreports_worker"), "Worker permission required");
                require(!Boolean.TRUE.equals(grant.get("runOnly")), "Only persistent grants can be invalidated");
                require(Objects.equals(input.get("fingerprint"), grant.get("fingerprint")), "Grant mismatch");
                internal(() -> { var current = client.get(new GetRequest(INDEX, id)).actionGet(); require(current.isExists(), "Grant unavailable");
                    Map<String,Object> revoked = current.getSourceAsMap(); require(Objects.equals(input.get("fingerprint"), revoked.get("fingerprint")), "Grant mismatch");
                    revoked.put("revoked", true); revoked.put("revokedAt", Instant.now().toString()); revoked.put("revokedBy", "betterreports_worker");
                    return client.index(new IndexRequest(INDEX).id(id).source(revoked).setIfSeqNo(current.getSeqNo()).setIfPrimaryTerm(current.getPrimaryTerm()).setRefreshPolicy(WriteRequest.RefreshPolicy.IMMEDIATE)).actionGet(); });
                org.apache.logging.log4j.LogManager.getLogger(Service.class).info("betterreports action=invalidate grant={} fingerprintBound=true", id);
                return Map.of("invalidated", true);
            }
            if (op.equals("revoke")) {
                ownerOrManager(grant, caller);
                internal(() -> { var current = client.get(new GetRequest(INDEX, id)).actionGet(); Map<String,Object> revoked = current.getSourceAsMap(); revoked.put("revoked", true); revoked.put("revokedAt", Instant.now().toString()); revoked.put("revokedBy", caller.getName());
                    return client.index(new IndexRequest(INDEX).id(id).source(revoked).setIfSeqNo(current.getSeqNo()).setIfPrimaryTerm(current.getPrimaryTerm()).setRefreshPolicy(WriteRequest.RefreshPolicy.IMMEDIATE)).actionGet(); });
                org.apache.logging.log4j.LogManager.getLogger(Service.class).info("betterreports action=revoke grant={} actor={} tenant={}", id, caller.getName(), tenant(caller));
                return summary(id, get(id));
            }
            if (op.equals("check") && !caller.getSecurityRoles().contains("betterreports_worker") && !caller.getSecurityRoles().contains("all_access")) { tenantAccess(); ownerOrManager(grant, caller); }
            active(grant); require(Objects.equals(input.get("fingerprint"), grant.get("fingerprint")), "Report changed: authorize this revision again");
            if (op.equals("check")) return summary(id, grant);
            if (op.equals("send")) {
                require(!Boolean.TRUE.equals(grant.get("runOnly")), "Scheduled authorization required for delivery");
                User executionUser = User.fromSerializedBase64((String)grant.get("user"));
                try (ThreadContext.StoredContext ignored = pool.getThreadContext().stashContext()) {
                    pool.getThreadContext().putTransient(ConfigConstants.OPENDISTRO_SECURITY_USER, executionUser);
                    pool.getThreadContext().putTransient("_opendistro_security_injected_roles", "plugin|" + String.join(",", executionUser.getSecurityRoles()));
                    // Populate Notifications' owner metadata from the protected grant, never REST input.
                    pool.getThreadContext().putTransient(ConfigConstants.OPENDISTRO_SECURITY_USER_INFO_THREAD_CONTEXT,
                        executionUser.getName().replace("|", "\\|") + "|" + String.join(",", executionUser.getRoles()) + "|" + String.join(",", executionUser.getSecurityRoles()) + "|" + tenant(executionUser) + "|READ");
                    return new NotificationsBridge(this).send(input);
                }
            }
            interval(input); List<Object> results = new ArrayList<>();
            User executionUser = User.fromSerializedBase64((String)grant.get("user"));
            for (Map<String,Object> panel : (List<Map<String,Object>>)grant.get("panels")) {
                active(get(id));
                try (ThreadContext.StoredContext ignored = pool.getThreadContext().stashContext()) {
                    pool.getThreadContext().putTransient(ConfigConstants.OPENDISTRO_SECURITY_USER, executionUser);
                    // Transport-only role injection forces Security to evaluate the stored role set.
                    pool.getThreadContext().putTransient("_opendistro_security_injected_roles", "plugin|" + String.join(",", executionUser.getSecurityRoles()));
                    results.add(search(panel, string(input, "from"), string(input, "to")));
                }
            }
            active(get(id)); return Map.of("results", results);
        }
        void interval(Map<String,Object> input) {
            Instant from = Instant.parse(string(input, "from")), to = Instant.parse(string(input, "to"));
            if (from.isAfter(to) || java.time.Duration.between(from, to).toDays() > 3660) throw new IllegalArgumentException("Invalid reporting interval");
        }
        void validatePanel(Map<String,Object> panel) throws IOException {
            keys(panel, "index", "body", "timeField"); String index = string(panel, "index");
            require(!index.contains(":") && !index.startsWith(".") && !index.equals("*") && !index.contains(","), "Only explicit local business-data index patterns are allowed");
            require(panel.get("body") instanceof Map, "Query body required"); Map<String,Object> body = (Map<String,Object>)panel.get("body");
            keys(body, "query", "aggs", "aggregations", "size", "track_total_hits", "timeout");
            require(((Number)body.getOrDefault("size", 0)).intValue() == 0, "Aggregation-only reports are supported");
            rejectScripts(body);
        }
        void rejectScripts(Object value) {
            if (value instanceof Map<?,?> map) { for (var entry : map.entrySet()) { require(!Set.of("script", "script_fields", "runtime_mappings", "terms_lookup", "percolate", "more_like_this").contains(entry.getKey()), "Executable or external query content is not supported"); rejectScripts(entry.getValue()); } }
            if (value instanceof List<?> list) list.forEach(this::rejectScripts);
        }
        Object search(Map<String,Object> panel, String from, String to) throws IOException {
            Map<String,Object> body = parse(json(panel.get("body")));
            if (panel.get("timeField") instanceof String field && !field.isEmpty()) {
                Object original = body.getOrDefault("query", Map.of("match_all", Map.of()));
                body.put("query", Map.of("bool", Map.of("filter", List.of(original, Map.of("range", Map.of(field, Map.of("gte", from, "lte", to, "format", "strict_date_optional_time")))))));
            }
            body.put("size", 0); body.put("timeout", "240s"); body.put("track_total_hits", true);
            try (XContentParser parser = XContentType.JSON.xContent().createParser(registry, DeprecationHandler.THROW_UNSUPPORTED_OPERATION, json(body))) {
                var response = client.search(new SearchRequest(string(panel, "index")).source(SearchSourceBuilder.fromXContent(parser)).allowPartialSearchResults(false)).actionGet();
                if (response.isTimedOut() || response.getFailedShards() > 0) throw new IllegalStateException("Query incomplete");
                return parse(response.toString());
            }
        }
    }
}
