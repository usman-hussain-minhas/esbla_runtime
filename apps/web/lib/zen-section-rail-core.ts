import {
  getPresentationSurfaceDefinition,
  getZenV1RegisteredSurfaceInstances,
  getZenV1SurfaceContract,
  type PresentationSurfaceDefinition,
  type ZenV1SurfaceId,
  zenV1SurfaceIds,
} from "@esbla/contracts";

export interface ZenSurfaceSectionRegistration {
  readonly authorizedContentAnchorIds: readonly string[];
  readonly headingId: string;
  readonly id: string;
  readonly label: string;
  readonly widgetInstanceIds: readonly string[];
}

export interface ZenEligibleSurfaceSection {
  readonly headingId: string;
  readonly id: string;
  readonly label: string;
}

export interface ZenSurfaceSectionEligibility {
  readonly authorizedContentAnchorIds: readonly string[];
  readonly eligibleWidgetInstanceIds: readonly string[];
}

export interface ZenSurfaceSectionDefinition {
  readonly sectionDefinitionVersion: number;
  readonly sections: readonly ZenSurfaceSectionRegistration[];
  readonly surfaceBaseVersion: number;
  readonly surfaceCanonicalHash: string;
  readonly surfaceDefinitionHash: string;
}

const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validIdentifier(value: string): boolean {
  return value.length <= 160 && identifierPattern.test(value);
}

function validLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    value.trim() === value &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
  );
}

function validUniqueIdentifiers(values: readonly string[]): boolean {
  return values.every(validIdentifier) && new Set(values).size === values.length;
}

function assertRegistry(registrations: readonly ZenSurfaceSectionRegistration[]): void {
  const sectionIds = new Set<string>();
  const headingIds = new Set<string>();
  if (registrations.length > 20) throw new Error("Invalid Zen surface section registry");
  for (const registration of registrations) {
    if (
      !validIdentifier(registration.id) ||
      !validIdentifier(registration.headingId) ||
      !validLabel(registration.label) ||
      !validUniqueIdentifiers(registration.widgetInstanceIds) ||
      !validUniqueIdentifiers(registration.authorizedContentAnchorIds) ||
      registration.widgetInstanceIds.length + registration.authorizedContentAnchorIds.length ===
        0 ||
      sectionIds.has(registration.id) ||
      headingIds.has(registration.headingId)
    ) {
      throw new Error("Invalid Zen surface section registry");
    }
    sectionIds.add(registration.id);
    headingIds.add(registration.headingId);
  }
}

export const ZEN_SURFACE_SECTION_REGISTRY = deepFreeze({
  "surface.hr.mission-control": {
    sectionDefinitionVersion: 1,
    sections: [
      {
        authorizedContentAnchorIds: ["hr-services"],
        headingId: "hr-hub-heading",
        id: "overview",
        label: "Overview",
        widgetInstanceIds: [
          "hr-mission-control.my-profile",
          "hr-mission-control.current-employment",
          "hr-mission-control.my-work",
          "hr-mission-control.my-published-shifts",
          "hr-mission-control.my-attendance",
          "hr-mission-control.my-leave",
          "hr-mission-control.my-timesheets",
          "hr-mission-control.my-expenses",
          "hr-mission-control.employment-admin",
          "hr-mission-control.employment-history",
          "hr-mission-control.workforce-admin",
          "hr-mission-control.workforce-status",
          "hr-mission-control.roster-overview",
          "hr-mission-control.roster-publish",
          "hr-mission-control.attendance-reports",
          "hr-mission-control.attendance-corrections",
          "hr-mission-control.leave-assigned",
          "hr-mission-control.leave-history",
          "hr-mission-control.leave-request",
          "hr-mission-control.timesheet-assigned",
          "hr-mission-control.timesheet-draft",
          "hr-mission-control.timesheet-corrections",
          "hr-mission-control.expense-assigned",
          "hr-mission-control.expense-draft",
          "hr-mission-control.expense-corrections",
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "dafe03ca3473b95bc679c67f531dd62c3d5b95c06a5339155a95407733392a4b",
    surfaceDefinitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
  },
  "surface.hr.requests-and-claims": {
    sectionDefinitionVersion: 1,
    sections: [
      {
        authorizedContentAnchorIds: [],
        headingId: "hr-requests-and-claims-heading",
        id: "overview",
        label: "Overview",
        widgetInstanceIds: [
          "hr-requests-and-claims.my-leave",
          "hr-requests-and-claims.leave-request-form",
          "hr-requests-and-claims.leave-assigned",
          "hr-requests-and-claims.leave-history",
          "hr-requests-and-claims.my-expenses",
          "hr-requests-and-claims.expense-draft",
          "hr-requests-and-claims.expense-assigned",
          "hr-requests-and-claims.expense-corrections",
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "879b2e93a964a5685392946ef6c5f8c79befea6a6f9328a28432a27dbf476259",
    surfaceDefinitionHash: "2436f49c88ac0e71c1dca8c1c0d9027e86e5c8a92ee2a8a725c7ff19d2caebdc",
  },
  "surface.hr.time-and-scheduling": {
    sectionDefinitionVersion: 1,
    sections: [
      {
        authorizedContentAnchorIds: [],
        headingId: "hr-time-and-scheduling-heading",
        id: "overview",
        label: "Overview",
        widgetInstanceIds: [
          "hr-time-and-scheduling.my-published-shifts",
          "hr-time-and-scheduling.roster-overview",
          "hr-time-and-scheduling.publish-queue",
          "hr-time-and-scheduling.my-attendance",
          "hr-time-and-scheduling.attendance-reports",
          "hr-time-and-scheduling.attendance-correction-queue",
          "hr-time-and-scheduling.my-timesheets",
          "hr-time-and-scheduling.timesheet-draft",
          "hr-time-and-scheduling.timesheet-assigned",
          "hr-time-and-scheduling.timesheet-corrections",
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "bbd0d87dded7676e1894ecb6e644adf7803de1417c5b86c3e770c7955bc88f32",
    surfaceDefinitionHash: "1308489fb489e2638eeafd8e57a9db7de08a8690cca247e69e8492014c3d4629",
  },
  "surface.hr.workforce": {
    sectionDefinitionVersion: 1,
    sections: [
      {
        authorizedContentAnchorIds: [],
        headingId: "hr-workforce-heading",
        id: "overview",
        label: "Overview",
        widgetInstanceIds: [
          "hr-workforce.my-profile",
          "hr-workforce.direct-reports",
          "hr-workforce.admin-queue",
          "hr-workforce.status-reporting",
          "hr-workforce.current-employment",
          "hr-workforce.employment-history",
          "hr-workforce.employment-admin-queue",
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "d4c9e5727e17afd3b412b2625e362e9e022b69bd6082afebf263a70199a06895",
    surfaceDefinitionHash: "8c945cf827e6949b3f454bd8afdea68351ebbd6de68062933a48845aa3af32c3",
  },
  "surface.mission-control": {
    sectionDefinitionVersion: 1,
    sections: [
      {
        authorizedContentAnchorIds: [],
        headingId: "mission-control-heading",
        id: "overview",
        label: "Overview",
        widgetInstanceIds: [
          "mission-control.my-work",
          "mission-control.my-published-shifts",
          "mission-control.my-leave",
          "mission-control.my-attendance",
          "mission-control.my-timesheets",
          "mission-control.my-expenses",
          "mission-control.my-profile",
          "mission-control.direct-reports",
          "mission-control.employment-admin",
          "mission-control.employment-history",
          "mission-control.workforce-admin",
          "mission-control.workforce-status",
          "mission-control.my-tasks",
          "mission-control.roster-overview",
          "mission-control.roster-publish",
          "mission-control.attendance-reports",
          "mission-control.attendance-corrections",
          "mission-control.leave-assigned",
          "mission-control.leave-history",
          "mission-control.leave-request",
          "mission-control.timesheet-assigned",
          "mission-control.timesheet-draft",
          "mission-control.timesheet-corrections",
          "mission-control.expense-assigned",
          "mission-control.expense-draft",
          "mission-control.expense-corrections",
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "d6a467292414d34beb296b81f2b40b50132f1ebd8fd040a9a6e2dc4d93c364e3",
    surfaceDefinitionHash: "c75bac3fed1b604fe9ebc9f39e1ccef45b2ad34570f5200ada0e8b77ab8b71fb",
  },
} as const satisfies Readonly<Record<ZenV1SurfaceId, ZenSurfaceSectionDefinition>>);

function assertSurfaceBinding(
  surface: Pick<PresentationSurfaceDefinition, "baseVersion" | "definitionHash" | "id">,
  registration: ZenSurfaceSectionDefinition,
): void {
  const canonicalSurface = getPresentationSurfaceDefinition(surface.id);
  const contract = getZenV1SurfaceContract(surface.id);
  assertRegistry(registration.sections);
  if (
    !Number.isSafeInteger(registration.sectionDefinitionVersion) ||
    registration.sectionDefinitionVersion < 1 ||
    surface.baseVersion !== registration.surfaceBaseVersion ||
    surface.definitionHash !== registration.surfaceDefinitionHash ||
    canonicalSurface.baseVersion !== registration.surfaceBaseVersion ||
    canonicalSurface.definitionHash !== registration.surfaceDefinitionHash ||
    contract.baseVersion !== registration.surfaceBaseVersion ||
    contract.definitionHash !== registration.surfaceDefinitionHash ||
    contract.canonicalHash !== registration.surfaceCanonicalHash
  ) {
    throw new Error("Invalid Zen surface section binding");
  }
  const registeredInstances = getZenV1RegisteredSurfaceInstances(surface.id);
  const expectedSectionIds = [...new Set(registeredInstances.map(({ sectionId }) => sectionId))];
  if (
    JSON.stringify(registration.sections.map(({ id }) => id)) !== JSON.stringify(expectedSectionIds)
  ) {
    throw new Error("Invalid Zen surface section binding");
  }
  const registeredWidgetInstances = new Set<string>();
  for (const section of registration.sections) {
    for (const instanceId of section.widgetInstanceIds) {
      const instance = registeredInstances.find((candidate) => candidate.instanceId === instanceId);
      if (
        !instance ||
        instance.sectionId !== section.id ||
        registeredWidgetInstances.has(instanceId)
      ) {
        throw new Error("Invalid Zen surface section binding");
      }
      registeredWidgetInstances.add(instanceId);
    }
  }
  if (registeredWidgetInstances.size !== registeredInstances.length) {
    throw new Error("Invalid Zen surface section binding");
  }
}

for (const surfaceId of zenV1SurfaceIds) {
  assertSurfaceBinding(
    getPresentationSurfaceDefinition(surfaceId),
    ZEN_SURFACE_SECTION_REGISTRY[surfaceId],
  );
}

export function resolveEligibleZenSurfaceSections(
  registrations: readonly ZenSurfaceSectionRegistration[],
  eligibility: ZenSurfaceSectionEligibility,
): readonly ZenEligibleSurfaceSection[] {
  assertRegistry(registrations);
  if (
    !validUniqueIdentifiers(eligibility.eligibleWidgetInstanceIds) ||
    !validUniqueIdentifiers(eligibility.authorizedContentAnchorIds)
  ) {
    throw new Error("Invalid Zen surface section eligibility");
  }
  const eligibleWidgetInstances = new Set(eligibility.eligibleWidgetInstanceIds);
  const authorizedContentAnchors = new Set(eligibility.authorizedContentAnchorIds);
  return registrations.flatMap((registration) => {
    const eligible =
      registration.widgetInstanceIds.some((id) => eligibleWidgetInstances.has(id)) ||
      registration.authorizedContentAnchorIds.some((id) => authorizedContentAnchors.has(id));
    return eligible
      ? [
          {
            headingId: registration.headingId,
            id: registration.id,
            label: registration.label,
          },
        ]
      : [];
  });
}

export function getEligibleZenSurfaceSections(
  surface: Pick<PresentationSurfaceDefinition, "baseVersion" | "definitionHash" | "id">,
  eligibility: ZenSurfaceSectionEligibility,
): readonly ZenEligibleSurfaceSection[] {
  const registration = ZEN_SURFACE_SECTION_REGISTRY[surface.id];
  assertSurfaceBinding(surface, registration);
  return resolveEligibleZenSurfaceSections(registration.sections, eligibility);
}
