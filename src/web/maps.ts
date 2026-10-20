import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { coordinates, WebError } from "./contracts.js";
const hosts = new Set([
  "maps.app.goo.gl",
  "maps.google.com",
  "www.google.com",
  "google.com",
  "goo.gl",
]);
export function mapsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError("invalid_maps_link");
  }
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    !hosts.has(u.hostname) ||
    isIP(u.hostname)
  )
    throw new WebError("invalid_maps_link");
  if (u.hostname === "goo.gl" && !u.pathname.startsWith("/maps/"))
    throw new WebError("invalid_maps_link");
  if (
    ["google.com", "www.google.com", "maps.google.com"].includes(u.hostname) &&
    u.pathname !== "/maps" &&
    !u.pathname.startsWith("/maps/")
  )
    throw new WebError("invalid_maps_link");
  return u;
}
export function selectedCoordinates(
  u: URL,
): { latitude: number; longitude: number } | undefined {
  if (u.searchParams.has("query_place_id"))
    throw new WebError("ambiguous_maps_link");
  const values: string[] = [];
  for (const key of ["query", "q", "destination"]) {
    const v = u.searchParams.get(key);
    if (v && /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(v)) values.push(v);
  }
  // !3d/!4d identifies selected place geometry. @lat,lng is only the viewport.
  for (const m of decodeURIComponent(u.pathname + u.search).matchAll(
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g,
  ))
    values.push(`${m[1]},${m[2]}`);
  const unique = [...new Set(values.map((v) => v.replace(/\s/g, "")))];
  if (unique.length > 1) throw new WebError("ambiguous_maps_link");
  if (!unique.length) return undefined;
  const [latitude, longitude] = unique[0].split(",").map(Number);
  return coordinates.parse({ latitude, longitude });
}
export function publicAddress(address: string): boolean {
  // Global IPv6 unicast only; reject mapped, link-local, unique-local and special/documentation ranges.
  if (isIP(address) === 6)
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2001:(?:db8|0|1|2):/i.test(address)
    );
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export async function redirect(u: URL): Promise<string | null> {
  const resolved = await lookup(u.hostname, { all: true });
  if (!resolved.length || resolved.some((r) => !publicAddress(r.address)))
    throw new WebError("maps_network_destination_blocked");
  const ip = resolved.find((r) => r.family === 4) ?? resolved[0];
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: "GET",
        lookup: ((_host: any, _opts: any, cb: any) =>
          _opts.all ? cb(null, [ip]) : cb(null, ip.address, ip.family)) as any,
        headers: {
          "User-Agent": "JobberMCP-MapResolver/1.0",
          Accept: "text/html",
        },
      },
      (res) => {
        const location = res.headers.location;
        res.destroy();
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          location
        )
          resolve(new URL(location, u).href);
        else if (res.statusCode === 200) resolve(null);
        else reject(new WebError("maps_resolution_failed"));
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(new WebError("maps_resolution_timeout")),
    );
    req.on("error", () => reject(new WebError("maps_resolution_failed")));
    req.end();
  });
}
export async function resolveMaps(
  raw: string,
  follow = redirect,
): Promise<{ latitude: number; longitude: number }> {
  let u = mapsUrl(raw);
  for (let n = 0; n <= 5; n++) {
    const pin = selectedCoordinates(u);
    if (pin) return pin;
    if (n === 5) break;
    const next = await follow(u);
    if (!next) break;
    u = mapsUrl(next);
  }
  throw new WebError("coordinates_required_for_ambiguous_link");
}
