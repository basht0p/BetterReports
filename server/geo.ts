import * as echarts from 'echarts';
import { ReportError } from '../common/model';

const topology = require('world-atlas/countries-110m.json');
const countries = require('iso-3166-1');
const { feature } = require('topojson-client');
const geojson = feature(topology, topology.objects.countries);
const byName = new Map<string, string>();
for (const shape of geojson.features) {
  const code = countries.whereNumeric(String(shape.id).padStart(3, '0'));
  const name = shape.properties.name;
  for (const key of [shape.id, name, code?.country, code?.alpha2, code?.alpha3]) if (key) byName.set(String(key).toLowerCase(), name);
}
echarts.registerMap('better-reports-world', geojson);

export function countryName(key: string): string | undefined { return byName.get(key.toLowerCase()); }

export function geohashCenter(hash: string): [number, number] {
  const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz';
  let lon: [number, number] = [-180, 180], lat: [number, number] = [-90, 90], even = true;
  if (!hash || hash.length > 12) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Invalid geohash bucket ${hash}.`);
  for (const letter of hash.toLowerCase()) {
    const index = alphabet.indexOf(letter);
    if (index < 0) throw new ReportError('UNSUPPORTED_CONFIGURATION', `Invalid geohash bucket ${hash}.`);
    for (const mask of [16, 8, 4, 2, 1]) {
      const bounds = even ? lon : lat;
      const mid = (bounds[0] + bounds[1]) / 2;
      if (index & mask) bounds[0] = mid; else bounds[1] = mid;
      even = !even;
    }
  }
  return [(lon[0] + lon[1]) / 2, (lat[0] + lat[1]) / 2];
}
