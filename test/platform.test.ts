import { describe, expect, it } from "vitest";
import {
  browserCommand, detectContainerEnvironment, isLoopbackHost, normalizePlatform, notificationCommand,
} from "../src/platform.js";

describe("platform helpers", () => {
  it("selects xdg-open on Linux", () => {
    expect(browserCommand("linux")).toEqual({ bin: "xdg-open", args: [] });
  });

  it("selects open on macOS", () => {
    expect(browserCommand("darwin")).toEqual({ bin: "open", args: [] });
  });

  it("selects notify-send on Linux", () => {
    expect(notificationCommand("title", "body", "linux")).toEqual({
      bin: "notify-send", args: ["title", "body"],
    });
  });

  it("selects osascript on macOS", () => {
    const cmd = notificationCommand("title", "body", "darwin");
    expect(cmd?.bin).toBe("osascript");
    expect(cmd?.args[0]).toBe("-e");
  });

  it("degrades gracefully on unsupported platforms", () => {
    expect(normalizePlatform("win32")).toBe("other");
    expect(browserCommand("win32")).toBeNull();
    expect(notificationCommand("t", "b", "win32")).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  it("recognizes common loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("rejects non-loopback hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });
});

describe("detectContainerEnvironment", () => {
  it("is true when $container is set (systemd-nspawn/podman/toolbox convention)", () => {
    const prev = process.env.container;
    process.env.container = "podman";
    try {
      expect(detectContainerEnvironment()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.container; else process.env.container = prev;
    }
  });
});
