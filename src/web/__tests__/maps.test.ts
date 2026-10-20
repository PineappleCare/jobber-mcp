import { describe, it, expect, vi } from "vitest";
import {
  resolveMaps,
  mapsUrl,
  selectedCoordinates,
  publicAddress,
} from "../maps.js";
describe("Google Maps selected pins", () => {
  it("accepts public Google IPv4/IPv6 and rejects local, private and mapped destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "172.20.1.1",
      "100.64.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    for (const ip of ["142.250.1.1", "2607:f8b0:4007:80c::200e"])
      expect(publicAddress(ip)).toBe(true);
  });
  it.each([
    "https://www.google.com/maps/search/?api=1&query=47.2,-80.3",
    "https://maps.google.com/maps?q=47.2,-80.3",
    "https://www.google.com/maps/place/Example/@46,-79,10z/data=!3d47.2!4d-80.3",
  ])("extracts selected geometry from %s", async (raw) => {
    expect(await resolveMaps(raw)).toEqual({
      latitude: 47.2,
      longitude: -80.3,
    });
  });
  it("resolves short links through bounded validated redirects without cookies", async () => {
    const follow = vi
      .fn()
      .mockResolvedValueOnce(
        "https://www.google.com/maps/search/?query=47.2,-80.3",
      );
    expect(
      await resolveMaps("https://maps.app.goo.gl/fixture", follow),
    ).toEqual({ latitude: 47.2, longitude: -80.3 });
    expect(follow).toHaveBeenCalledTimes(1);
  });
  it.each([
    "http://maps.app.goo.gl/a",
    "https://maps.app.goo.gl.evil.test/a",
    "https://google.com.evil/maps",
    "https://127.0.0.1/maps",
    "https://google.com:444/maps",
    "https://user:pass@google.com/maps",
    "https://google.com/redirect?url=http://localhost",
  ])("blocks arbitrary destinations %s", (raw) => {
    expect(() => mapsUrl(raw)).toThrow();
  });
  it("checks every redirect and never treats viewport as selected pin", async () => {
    await expect(
      resolveMaps(
        "https://maps.app.goo.gl/a",
        async () => "http://169.254.169.254/",
      ),
    ).rejects.toThrow("invalid_maps_link");
    expect(
      selectedCoordinates(
        new URL("https://www.google.com/maps/@47.2,-80.3,14z"),
      ),
    ).toBeUndefined();
    await expect(
      resolveMaps(
        "https://www.google.com/maps/@47.2,-80.3,14z",
        async () => null,
      ),
    ).rejects.toThrow("coordinates_required");
  });
  it("rejects ambiguous geometry and redirect loops", async () => {
    await expect(
      resolveMaps("https://www.google.com/maps?query=47,-80&q=48,-81"),
    ).rejects.toThrow("ambiguous");
    const follow = vi.fn(async () => "https://maps.app.goo.gl/a");
    await expect(
      resolveMaps("https://maps.app.goo.gl/a", follow),
    ).rejects.toThrow("coordinates_required");
    expect(follow).toHaveBeenCalledTimes(5);
  });
});
