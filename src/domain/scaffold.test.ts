import { describe, it, expect } from "vitest";
import {
  parseReviewScaffold,
  reviewScaffoldJsonSchema,
  type ReviewScaffold,
} from "./scaffold.ts";

const validScaffold: ReviewScaffold = {
  pr: {
    number: 42,
    title: "Add rate limiting to the ingest endpoint",
    description: "Guards against abusive clients.",
    baseSha: "aaaa1111",
    headSha: "bbbb2222",
  },
  layers: [
    {
      id: "layer-1",
      anchors: [
        { file: "src/server/rate-limit.ts", side: "RIGHT", startLine: 10, endLine: 24 },
      ],
      order: 0,
      bundle: {
        summary: "Introduces a token-bucket limiter used by the ingest route.",
        neighbors: [
          {
            ref: "src/server/ingest.ts#handleIngest",
            signature: "handleIngest(req, res): Promise<void>",
            oneLine: "Route handler that now calls the limiter.",
          },
        ],
        history: [
          {
            sha: "cccc3333",
            subject: "Extract ingest route into its own module",
            whenRelevant: "Established the handler this layer modifies.",
          },
        ],
        learnings: [],
      },
      findings: [
        {
          anchor: {
            file: "src/server/rate-limit.ts",
            side: "RIGHT",
            startLine: 15,
            endLine: 15,
          },
          concern: "security",
          severity: "major",
          text: "The bucket key is derived from a client-supplied header and can be spoofed.",
          suggestedFix: null,
        },
      ],
    },
  ],
};

describe("parseReviewScaffold", () => {
  it("round-trips a valid scaffold", () => {
    const parsed = parseReviewScaffold(validScaffold);
    expect(parsed).toEqual(validScaffold);
  });

  it("rejects an anchor with endLine < startLine", () => {
    const bad = structuredClone(validScaffold);
    bad.layers[0]!.anchors[0]!.endLine = 5; // startLine is 10
    expect(() => parseReviewScaffold(bad)).toThrow();
  });

  it("rejects an unknown concern", () => {
    const bad = structuredClone(validScaffold) as unknown as {
      layers: { findings: { concern: string }[] }[];
    };
    bad.layers[0]!.findings[0]!.concern = "style";
    expect(() => parseReviewScaffold(bad)).toThrow();
  });

  it("rejects a layer with no anchors", () => {
    const bad = structuredClone(validScaffold);
    bad.layers[0]!.anchors = [] as unknown as (typeof bad.layers)[0]["anchors"];
    expect(() => parseReviewScaffold(bad)).toThrow();
  });
});

describe("reviewScaffoldJsonSchema", () => {
  const schema = reviewScaffoldJsonSchema as {
    additionalProperties?: unknown;
    properties: {
      layers: {
        items: {
          additionalProperties?: unknown;
          properties: { bundle: { additionalProperties?: unknown } };
        };
      };
    };
  };

  it("has additionalProperties === false at the top level", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it("has additionalProperties === false on the Layer object", () => {
    expect(schema.properties.layers.items.additionalProperties).toBe(false);
  });

  it("has additionalProperties === false on the ContextBundle object", () => {
    expect(
      schema.properties.layers.items.properties.bundle.additionalProperties,
    ).toBe(false);
  });
});
