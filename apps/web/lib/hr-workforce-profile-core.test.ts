import { describe, expect, it } from "vitest";
import {
  decodeOwnWorkforceProfileResponse,
  HrWorkforceProfileViewError,
} from "./hr-workforce-profile-core.js";

const profile = {
  createdAt: "2026-07-21T06:00:00.000Z",
  employeeNumber: "EMP-0001",
  principalLinked: true,
  updatedAt: "2026-07-21T06:05:00.000Z",
  version: 3,
  workerProfileId: "10000000-0000-4000-8000-000000000201",
  workforceStatus: "active",
} as const;

function json(body: unknown, status = 200, contentType = "application/json") {
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { "content-type": contentType }, status }),
  );
}

function problem(code: string, status: number) {
  return json(
    {
      code,
      detail: "Sanitized detail",
      instance: "/v1/hr/workforce-profiles/own",
      requestId: "10000000-0000-4000-8000-000000000001",
      status,
      title: status === 403 ? "Forbidden" : "Service Unavailable",
      type: `urn:esbla:problem:${code.toLowerCase()}`,
    },
    status,
    "application/problem+json",
  );
}

describe("own workforce profile transport", () => {
  it("accepts only an exact active linked profile", async () => {
    await expect(decodeOwnWorkforceProfileResponse(json(profile))).resolves.toEqual({
      profile,
      status: "ready",
    });
    await expect(
      decodeOwnWorkforceProfileResponse(json({ ...profile, tenantId: "private" })),
    ).rejects.toBeInstanceOf(HrWorkforceProfileViewError);
    await expect(
      decodeOwnWorkforceProfileResponse(
        json({ ...profile, principalLinked: false, workforceStatus: "draft" }),
      ),
    ).rejects.toBeInstanceOf(HrWorkforceProfileViewError);
  });

  it("maps only exact expected fail-closed product states", async () => {
    await expect(
      decodeOwnWorkforceProfileResponse(problem("WORKFORCE_PROFILE_SERVICE_INACTIVE", 503)),
    ).resolves.toEqual({ status: "inactive" });
    await expect(decodeOwnWorkforceProfileResponse(problem("POLICY_DENIED", 403))).resolves.toEqual(
      { status: "not_linked_or_denied" },
    );
  });

  it("rejects mismatched status, media type, and malformed success", async () => {
    await expect(
      decodeOwnWorkforceProfileResponse(problem("WORKFORCE_PROFILE_SERVICE_INACTIVE", 403)),
    ).rejects.toBeInstanceOf(HrWorkforceProfileViewError);
    await expect(
      decodeOwnWorkforceProfileResponse(json(profile, 200, "text/plain")),
    ).rejects.toBeInstanceOf(HrWorkforceProfileViewError);
    await expect(decodeOwnWorkforceProfileResponse(json({}, 200))).rejects.toBeInstanceOf(
      HrWorkforceProfileViewError,
    );
  });
});
