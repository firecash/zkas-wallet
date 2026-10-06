import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseServicesDocument,
  readCachedServices,
  refreshServicesDirectory,
  SERVICES_DIRECTORY_URL,
} from "../src/services-directory";

const validDocument = {
  schema_version: 1,
  updated_at: "2026-08-09T00:00:00Z",
  services: [{
    id: "merchant-one",
    name: "Merchant One",
    description: "Accepts ZKAS online.",
    categories: ["use"],
    status: "Live",
    tags: ["Online"],
    action: "Visit merchant",
    href: "https://merchant.example/pay",
    icon: "credit-card",
  }],
};

describe("services directory", () => {
  beforeEach(() => localStorage.clear());

  it("accepts a valid v1 directory", () => {
    expect(parseServicesDocument(validDocument)?.services[0]).toMatchObject({
      id: "merchant-one",
      categories: ["use"],
      href: "https://merchant.example/pay",
    });
  });

  it("rejects unsafe links, unknown schemas, and duplicate IDs", () => {
    expect(parseServicesDocument({ ...validDocument, schema_version: 2 })).toBeNull();
    expect(parseServicesDocument({
      ...validDocument,
      services: [{ ...validDocument.services[0], href: "http://merchant.example" }],
    })).toBeNull();
    expect(parseServicesDocument({
      ...validDocument,
      services: [validDocument.services[0], validDocument.services[0]],
    })).toBeNull();
  });

  it("downloads, validates, and retains the last valid directory", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(validDocument), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const services = await refreshServicesDirectory(fetcher, localStorage);

    expect(fetcher).toHaveBeenCalledWith(SERVICES_DIRECTORY_URL, expect.objectContaining({
      cache: "no-cache",
      credentials: "omit",
    }));
    // The remote entry is present and the bundled list is still underneath it:
    // bundled services are a floor (20a76c2) so the Use tab cannot go empty, so
    // the remote document ADDS to them rather than replacing them. Asserting an
    // index asserted the merge order, which is not a promise to anyone.
    expect(services.map((s) => s.id)).toContain("merchant-one");
    expect(services.map((s) => s.id)).toContain("ai-uncensored");
    expect(readCachedServices(localStorage)?.map((s) => s.id)).toContain("merchant-one");
  });

  it("lets the remote directory override a bundled entry of the same id", async () => {
    // Otherwise the "floor" would be a ceiling: a bundled description could never
    // be corrected remotely.
    const override = {
      ...validDocument,
      services: [{ ...validDocument.services[0], id: "ai-uncensored", name: "Renamed Remotely" }],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(override), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const services = await refreshServicesDirectory(fetcher, localStorage);
    const hit = services.filter((s) => s.id === "ai-uncensored");
    expect(hit).toHaveLength(1);
    expect(hit[0].name).toBe("Renamed Remotely");
  });

  it("does not replace the cache when an update is malformed", async () => {
    localStorage.setItem("zkas_services_directory_v1", JSON.stringify(validDocument));
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    await expect(refreshServicesDirectory(fetcher, localStorage)).rejects.toThrow("failed validation");
    expect(readCachedServices(localStorage)?.map((s) => s.id)).toContain("merchant-one");
  });
});
