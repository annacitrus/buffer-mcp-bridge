import test from "node:test";
import assert from "node:assert/strict";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { compileSchema } from "../src/schema.js";
import { body } from "../src/contract.js";

test("draft-07 tuples and 2020 prefixItems retain their dialect", async () => {
  for (const [dialect, tuple] of [
    [
      "http://json-schema.org/draft-07/schema#",
      { items: [{ type: "string" }], additionalItems: false },
    ],
    [
      "https://json-schema.org/draft/2020-12/schema",
      { prefixItems: [{ type: "string" }], items: false },
    ],
  ] as const) {
    const schema = {
      $schema: dialect,
      type: "object",
      properties: { args: { type: "array", ...tuple } },
      required: ["args"],
    };
    const validate = compileSchema(schema);
    assert.equal(validate({ args: ["ok"] }), true);
    assert.equal(validate({ args: [1] }), false);
    assert.equal(validate({ args: ["ok", "extra"] }), false);
    const wrapped = fromJsonSchema({
      $schema: dialect,
      type: "object",
      properties: { arguments: schema },
      required: ["arguments"],
    } as any);
    assert.equal(
      (await wrapped["~standard"].validate({ arguments: { args: ["ok"] } }))
        .issues,
      undefined,
    );
    assert.ok(
      (await wrapped["~standard"].validate({ arguments: { args: [1] } }))
        .issues,
    );
  }
  assert.throws(() =>
    compileSchema({ $schema: "https://example.com/unknown", type: "object" }),
  );
});

test("Buffer's trailing rate limit block is metadata; other payloads fail closed", () => {
  const content = [
    { type: "text", text: JSON.stringify({ id: "account" }) },
    {
      type: "text",
      text: JSON.stringify({
        rateLimit: [{ remaining: 149, resetSeconds: 900 }],
      }),
    },
  ];
  assert.deepEqual(body({ content }), { id: "account" });
  assert.throws(() => body({ content: [content[0], content[0]] }));
  assert.throws(() => body({ isError: true, content }));
});
