import { bodyLimit } from "hono/body-limit";

/**
 * All current capability transports accept bounded JSON request bodies. One MiB
 * leaves room for ordinary sourcing assessments while preventing an unbounded
 * body from reaching JSON parsing or schema validation.
 */
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export const jsonBodyLimit = () =>
  bodyLimit({
    maxSize: JSON_BODY_LIMIT_BYTES,
    onError: () =>
      Response.json(
        {
          error: {
            code: "REQUEST_BODY_TOO_LARGE",
            message: "Request body exceeds the maximum size",
          },
          ok: false,
        },
        { status: 413 }
      ),
  });
