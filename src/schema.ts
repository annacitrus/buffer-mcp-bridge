import { Ajv, type AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import addFormats from "ajv-formats";

// A schema's declared dialect applies to its nested schemas as well.
// Keep each compilation isolated so upstream $ids cannot collide.
export function compileSchema(schema: Record<string, any>) {
  const dialect = schema.$schema?.replace(/#$/, "");
  const options = { strict: false, allErrors: true };
  const ajv =
    !dialect || dialect === "https://json-schema.org/draft/2020-12/schema"
      ? new Ajv2020(options)
      : dialect === "http://json-schema.org/draft-07/schema" ||
          dialect === "https://json-schema.org/draft-07/schema"
        ? new Ajv(options)
        : dialect === "https://json-schema.org/draft/2019-09/schema"
          ? new Ajv2019(options)
          : undefined;
  if (!ajv) throw new Error("Unsupported JSON Schema dialect");
  (addFormats as any)(ajv);
  return ajv.compile(schema as AnySchema);
}
