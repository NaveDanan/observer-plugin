import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe("settings startup", () => {
  it("waits for one shared bootstrap before concurrent protected requests", async () => {
    vi.resetModules()
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const fetcher = vi.fn((path: string, options?: RequestInit) => {
      if (path === "/v1/bootstrap") return pending
      expect(options?.headers).toMatchObject({ authorization: "Bearer ready-token" })
      return Promise.resolve(Response.json(path === "/v1/roster" ? { profiles: [] } : { seats: {} }))
    })
    vi.stubGlobal("fetch", fetcher)
    const api = await import("../src/api")
    const config = api.getConfig()
    const roster = api.getRoster()
    const startup = api.bootstrap()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/v1/bootstrap")
    release(Response.json({ token: "ready-token" }))
    await expect(config).resolves.toEqual({ seats: {} })
    await expect(roster).resolves.toEqual({ profiles: [] })
    await startup
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it("propagates bootstrap failure without sending an unauthenticated request and permits retry", async () => {
    vi.resetModules()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ token: "recovered-token" }))
      .mockResolvedValueOnce(Response.json({ profiles: [] }))
    vi.stubGlobal("fetch", fetcher)
    const api = await import("../src/api")
    await expect(api.getRoster()).rejects.toThrow("503")
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(api.getRoster()).resolves.toEqual({ profiles: [] })
    expect(fetcher.mock.calls[2]?.[1].headers.authorization).toBe("Bearer recovered-token")
  })
})
