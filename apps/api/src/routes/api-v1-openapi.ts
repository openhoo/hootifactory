import { V1ErrorResponseSchema } from "@hootifactory/contracts";
import { z } from "@hootifactory/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute } from "hono-openapi";

type OpenApiSchemaObject = Record<string, unknown>;
type OpenApiResponseObject = {
  description: string;
  content?: Record<string, { schema: OpenApiSchemaObject }>;
};
type ApiV1DocResponse = {
  description: string;
  schema?: z.ZodType;
  status?: ContentfulStatusCode;
};
type ApiV1DocOptions = {
  operationId: string;
  summary: string;
  tag: string;
  description?: string;
  pathParams?: z.ZodType;
  query?: z.ZodType;
  requestBody?: {
    description?: string;
    required?: boolean;
    schema: z.ZodType;
  };
  response: ApiV1DocResponse;
  errorStatuses?: ContentfulStatusCode[];
  extraResponses?: Record<number, ApiV1DocResponse>;
};

function schemaObject(schema: z.ZodType): OpenApiSchemaObject {
  const json = z.toJSONSchema(schema, { io: "input" }) as OpenApiSchemaObject;
  delete json.$schema;
  return json;
}

function responseObject(description: string, schema?: z.ZodType): OpenApiResponseObject {
  if (!schema) return { description };
  return {
    description,
    content: {
      "application/json": {
        schema: schemaObject(schema),
      },
    },
  };
}

function parameterDocs(location: "path" | "query", schema: z.ZodType) {
  const json = schemaObject(schema);
  const properties = (json.properties ?? {}) as Record<string, OpenApiSchemaObject>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    description: typeof property.description === "string" ? property.description : undefined,
    schema: property,
  }));
}

export function doc(options: ApiV1DocOptions) {
  const successStatus = options.response.status ?? 200;
  const responses: Record<string, OpenApiResponseObject> = {
    [successStatus]: responseObject(options.response.description, options.response.schema),
  };
  const errorStatuses = options.errorStatuses ?? [400, 401, 403, 404];
  for (const status of errorStatuses) {
    responses[status] ??= responseObject(
      status === 400
        ? "Bad request"
        : status === 401
          ? "Authentication required"
          : status === 403
            ? "Forbidden"
            : status === 404
              ? "Not found"
              : "Error",
      V1ErrorResponseSchema,
    );
  }
  for (const [status, response] of Object.entries(options.extraResponses ?? {})) {
    const numericStatus = Number(status);
    responses[status] = responseObject(
      response.description,
      response.schema ?? (numericStatus >= 400 ? V1ErrorResponseSchema : undefined),
    );
  }

  const parameters = [
    ...(options.pathParams ? parameterDocs("path", options.pathParams) : []),
    ...(options.query ? parameterDocs("query", options.query) : []),
  ];

  return describeRoute({
    tags: [options.tag],
    operationId: options.operationId,
    summary: options.summary,
    description: options.description ?? options.summary,
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody: options.requestBody
      ? {
          description: options.requestBody.description,
          required: options.requestBody.required ?? true,
          content: {
            "application/json": {
              schema: schemaObject(options.requestBody.schema),
            },
          },
        }
      : undefined,
    responses,
  });
}
