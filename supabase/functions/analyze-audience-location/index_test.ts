import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  normalizeInsights,
  normalizeTargeting,
  validateRange,
} from "./index.ts";

Deno.test("validates only completed ranges of at most 28 days", () => {
  assertEquals(
    validateRange({ since: "2026-10-01", until: "2026-10-20" }, "2026-10-21"),
    {
      since: "2026-10-01",
      until: "2026-10-20",
    },
  );
  assertEquals(
    validateRange({ since: "2026-09-01", until: "2026-10-01" }, "2026-10-21"),
    null,
  );
  assertEquals(
    validateRange({ since: "2026-10-21", until: "2026-10-21" }, "2026-10-21"),
    null,
  );
  assertEquals(
    validateRange({ since: "bad", until: "2026-10-20" }, "2026-10-21"),
    null,
  );
  assertEquals(
    validateRange({
      since: "2026-10-01",
      until: "2026-10-20",
      extra: "unexpected",
    }, "2026-10-21"),
    null,
  );
});

Deno.test("normalizes locations without assuming Java delivery", () => {
  const included = normalizeTargeting({
    geo_locations: { regions: [{ key: "ID-JB", name: "Jawa Barat" }] },
    age_min: 25,
    age_max: 55,
    genders: [1],
    flexible_spec: [{ interests: [{ id: "1" }, { id: "2" }] }],
    custom_audiences: [{ id: "secret-id", name: "Private audience" }],
  });
  assertEquals(included.locations?.javaCoverage, "includes");
  assertEquals(included.interests?.count, 2);
  assertEquals(included.interests?.hasCustomAudiences, true);
  assertEquals("name" in included.interests!, false);
  const unknown = normalizeTargeting({
    geo_locations: { countries: [{ key: "ID", name: "Indonesia" }] },
  });
  assertEquals(unknown.locations?.javaCoverage, "not-targeted");
  assertEquals(normalizeTargeting(null).locations, null);
});

Deno.test("groups Meta action insights by type and keeps zero distinct from missing", () => {
  const groups = normalizeInsights([
    {
      adset_id: "a1",
      spend: "100000",
      actions: [{
        action_type: "onsite_conversion.messaging_conversation_started_7d",
        value: "10",
      }, { action_type: "leadgen.other", value: "3" }],
    },
    {
      adset_id: "a2",
      spend: "50000",
      actions: [{
        action_type: "onsite_conversion.messaging_conversation_started_7d",
        value: "0",
      }],
    },
    { adset_id: "a3", spend: "20000", actions: [] },
  ]);
  assertEquals(groups.get("a1")?.MESSAGING_CONVERSATION?.results, 10);
  assertEquals(groups.get("a1")?.LEAD?.costPerResult, 100000 / 3);
  assertEquals(groups.get("a2")?.MESSAGING_CONVERSATION?.results, 0);
  assertEquals(groups.has("a3"), false);
  assertNotEquals(groups.get("a1")?.MESSAGING_CONVERSATION?.results, null);
});
