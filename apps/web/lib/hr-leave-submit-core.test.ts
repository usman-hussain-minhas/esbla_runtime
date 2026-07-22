import { describe, expect, it } from "vitest";
import {
  decodeHrLeaveSubmitTransport,
  decodeSubmitLeaveRequestResponse,
  HrLeaveSubmitError,
  isSameOriginSubmission,
  parseHrLeaveSubmitTransport,
  submitFormStateForError,
  validateHrLeaveSubmission,
} from "./hr-leave-submit-core";

const request = {
  approverPrincipalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  categoryCode: "annual",
  correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  createdAt: "2026-07-10T00:00:00.000Z",
  decidedAt: null,
  decisionNote: null,
  employeePrincipalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  endDate: "2026-07-12",
  idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  reason: "Rest",
  startDate: "2026-07-11",
  status: "submitted",
  submittedAt: "2026-07-10T00:00:00.000Z",
  tenantId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  updatedAt: "2026-07-10T00:00:00.000Z",
  version: 1,
} as const;

function form(overrides: Readonly<Record<string, string>> = {}) {
  return {
    categoryCode: "annual",
    endDate: "2026-07-12",
    idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    reason: "  Rest  ",
    startDate: "2026-07-11",
    ...overrides,
  };
}

function problem(code: string, detail: string, status: number) {
  return {
    code,
    detail,
    instance: "/v1/hr/leave-requests",
    requestId: "request-1",
    status,
    title: "Request Failed",
    type: `urn:esbla:problem:${code.toLowerCase()}`,
  };
}

describe("HR leave submission boundary", () => {
  it("normalizes a valid whole-day request and rejects identity-bearing envelopes", () => {
    const result = validateHrLeaveSubmission(form());
    expect(result).toEqual({
      ok: true,
      value: {
        body: {
          categoryCode: "annual",
          endDate: "2026-07-12",
          reason: "Rest",
          startDate: "2026-07-11",
        },
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
    });
    expect(validateHrLeaveSubmission(form({ tenantId: "attacker-tenant" }))).toMatchObject({
      ok: false,
      state: { fieldErrors: {}, status: "error" },
    });
  });

  it("returns field-bound errors for malformed input and rejects an expired form key", () => {
    const invalid = validateHrLeaveSubmission(
      form({ categoryCode: "invented", endDate: "2026-02-29", reason: "x".repeat(2001) }),
    );
    expect(invalid).toMatchObject({
      ok: false,
      state: {
        fieldErrors: {
          categoryCode: "Choose a leave type.",
          endDate: "Enter a valid end date.",
          reason: "Reason must be 2,000 characters or fewer.",
        },
      },
    });
    expect(validateHrLeaveSubmission(form({ idempotencyKey: "bad" }))).toMatchObject({
      ok: false,
      state: { fieldErrors: {}, status: "error" },
    });
  });

  it("strictly decodes created and replayed API responses", async () => {
    await expect(
      decodeSubmitLeaveRequestResponse(
        Promise.resolve(new Response(JSON.stringify(request), { status: 201 })),
      ),
    ).resolves.toEqual(request);
    await expect(
      decodeSubmitLeaveRequestResponse(
        Promise.resolve(new Response(JSON.stringify(request), { status: 200 })),
      ),
    ).resolves.toEqual(request);
    await expect(
      decodeSubmitLeaveRequestResponse(
        Promise.resolve(
          new Response(JSON.stringify({ ...request, privateField: true }), { status: 201 }),
        ),
      ),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps only known API problems to safe product failures", async () => {
    await expect(
      decodeSubmitLeaveRequestResponse(
        Promise.resolve(
          new Response(
            JSON.stringify(
              problem("LEAVE_INPUT_INVALID", "Leave reason is required by tenant policy", 400),
            ),
            { status: 400 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ kind: "reason_required" });
    await expect(
      decodeSubmitLeaveRequestResponse(
        Promise.resolve(
          new Response(
            JSON.stringify(
              problem("LEAVE_MANAGER_REQUIRED", "Employee has no active assigned manager", 422),
            ),
            { status: 422 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ kind: "manager_required" });
    await expect(
      decodeSubmitLeaveRequestResponse(Promise.reject(new Error("private transport detail"))),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("produces safe, field-aware form states", () => {
    expect(submitFormStateForError(new HrLeaveSubmitError("reason_required"))).toEqual({
      fieldErrors: { reason: "Reason is required by your tenant policy." },
      message: "Review the highlighted field.",
      status: "error",
    });
    expect(submitFormStateForError(new Error("private"))).toEqual({
      fieldErrors: {},
      message: "We could not submit your request. Try again.",
      status: "error",
    });
  });

  it("requires same-origin transport and strictly decodes its response", () => {
    expect(
      isSameOriginSubmission(
        "http://localhost:3000/workspace/hr/leave/new/submit",
        "http://127.0.0.1:3000",
        "same-origin",
        "127.0.0.1:3000",
      ),
    ).toBe(true);
    expect(
      isSameOriginSubmission(
        "http://127.0.0.1:3000/workspace/hr/leave/new/submit",
        "https://127.0.0.1:3000",
        null,
        "127.0.0.1:3000",
      ),
    ).toBe(false);
    expect(
      parseHrLeaveSubmitTransport({
        leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        ok: true,
      }),
    ).toEqual({
      leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ok: true,
    });
    expect(
      parseHrLeaveSubmitTransport({
        ok: false,
        state: {
          fieldErrors: { reason: "Reason is required by your tenant policy." },
          message: "Review the highlighted field.",
          status: "error",
        },
      }),
    ).toMatchObject({ ok: false, state: { status: "error" } });
    expect(() =>
      parseHrLeaveSubmitTransport({
        leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        ok: true,
        private: "leak",
      }),
    ).toThrow("Submit response is invalid");
  });

  it("requires exact JSON 201 success with the stable ID before navigation", async () => {
    const success = {
      leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ok: true,
    };
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify(success), {
            headers: { "content-type": "application/json; charset=utf-8" },
            status: 201,
          }),
        ),
      ),
    ).resolves.toEqual(success);
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify(success), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify(success), {
            headers: { "content-type": "text/plain" },
            status: 201,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
  });

  it("rejects malformed, extra-field and URL-like stable success IDs", async () => {
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify([]), {
            headers: { "content-type": "application/json" },
            status: 201,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
            status: 201,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify({ leaveRequestId: "https://attacker.example", ok: true }), {
            headers: { "content-type": "application/json" },
            status: 201,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(
            JSON.stringify({
              leaveRequestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              ok: true,
              tenantId: "private",
            }),
            { headers: { "content-type": "application/json" }, status: 201 },
          ),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
  });

  it("accepts only bounded failure statuses with an exact failure state", async () => {
    const failure = {
      ok: false,
      state: {
        fieldErrors: {},
        message: "Review your request and try again.",
        status: "error",
      },
    };
    for (const status of [400, 403, 409, 415, 422, 503]) {
      await expect(
        decodeHrLeaveSubmitTransport(
          Promise.resolve(
            new Response(JSON.stringify(failure), {
              headers: { "content-type": "application/json" },
              status,
            }),
          ),
        ),
      ).resolves.toEqual(failure);
    }
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify(failure), {
            headers: { "content-type": "application/json" },
            status: 201,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response(JSON.stringify(failure), {
            headers: { "content-type": "application/json" },
            status: 500,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
  });

  it("fails opaquely for malformed JSON and transport rejection", async () => {
    await expect(
      decodeHrLeaveSubmitTransport(
        Promise.resolve(
          new Response("not-json", {
            headers: { "content-type": "application/json" },
            status: 201,
          }),
        ),
      ),
    ).rejects.toThrow("Submit response is invalid");
    await expect(
      decodeHrLeaveSubmitTransport(Promise.reject(new Error("private transport detail"))),
    ).rejects.toThrow("Submit response is invalid");
  });
});
