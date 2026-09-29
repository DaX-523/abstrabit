import { describe, expect, it, vi, afterEach } from "vitest";
import { detectMirrorKind, sendMirror } from "@/lib/mirror";
import { RetryableError, PermanentError } from "@/lib/jobs/runner";

describe("detectMirrorKind", () => {
  it("recognizes a Slack incoming webhook", () => {
    expect(detectMirrorKind("https://hooks.slack.com/services/T0/B0/xyz")).toBe("slack");
  });

  it("recognizes a Discord webhook", () => {
    expect(detectMirrorKind("https://discord.com/api/webhooks/123/abc")).toBe("discord");
  });

  it("rejects an http (non-https) url", () => {
    expect(detectMirrorKind("http://hooks.slack.com/services/T0/B0/xyz")).toBeNull();
  });

  it("rejects a host that isn't Slack or Discord (SSRF guard)", () => {
    expect(detectMirrorKind("https://evil.example.com/webhooks/123")).toBeNull();
    expect(detectMirrorKind("https://169.254.169.254/latest/meta-data")).toBeNull();
  });

  it("rejects a discord.com url that isn't a webhook path", () => {
    expect(detectMirrorKind("https://discord.com/api/v10/users/@me")).toBeNull();
  });

  it("returns null for an invalid url", () => {
    expect(detectMirrorKind("not a url")).toBeNull();
  });
});

describe("sendMirror", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws PermanentError (no request made) for a disallowed host", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendMirror("https://evil.example.com/x", { title: "t", lines: [] })).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts a Slack-shaped payload to a Slack url", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await sendMirror("https://hooks.slack.com/services/T0/B0/xyz", {
      title: "New report",
      lines: ["line one"],
    });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty("text");
    expect(body.text).toContain("New report");
  });

  it("posts a Discord-shaped payload (with allowed_mentions) to a Discord webhook url", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await sendMirror("https://discord.com/api/webhooks/1/tok", { title: "New report", lines: ["x"] });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.content).toContain("New report");
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("throws RetryableError with retryAfterMs on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429, headers: { "retry-after": "2" } })),
    );
    const err = await sendMirror("https://hooks.slack.com/services/T0/B0/xyz", {
      title: "t",
      lines: [],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).retryAfterMs).toBe(2000);
  });

  it("throws RetryableError on a 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 503 })));
    await expect(
      sendMirror("https://hooks.slack.com/services/T0/B0/xyz", { title: "t", lines: [] }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it("throws PermanentError on a 404 (e.g. a deleted webhook)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(
      sendMirror("https://hooks.slack.com/services/T0/B0/xyz", { title: "t", lines: [] }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("throws RetryableError on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      sendMirror("https://hooks.slack.com/services/T0/B0/xyz", { title: "t", lines: [] }),
    ).rejects.toBeInstanceOf(RetryableError);
  });
});
