import {
  getPresentationSurfaceDefinition,
  getZenV1SurfaceContract,
  type PresentationSurfaceDefinition,
  type ZenV1SurfaceId,
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
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "1a0c13e923f277cc37dfae449db024e40c7bd7d0f5563bbf50ef82cdb8d507db",
    surfaceDefinitionHash: "12e135cb9be3deeef974ec5af2362d7a8e68057bdba904976a29709afe601c36",
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
        ],
      },
    ],
    surfaceBaseVersion: 1,
    surfaceCanonicalHash: "d52358f33176620a8d21479732150b09673e3b177308a2d976d4dc287bd06b1c",
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
  const expectedSectionIds = [
    ...new Set(contract.defaultInstances.map(({ sectionId }) => sectionId)),
  ];
  if (
    JSON.stringify(registration.sections.map(({ id }) => id)) !== JSON.stringify(expectedSectionIds)
  ) {
    throw new Error("Invalid Zen surface section binding");
  }
  const registeredWidgetInstances = new Set<string>();
  for (const section of registration.sections) {
    for (const instanceId of section.widgetInstanceIds) {
      const instance = contract.defaultInstances.find(
        (candidate) => candidate.instanceId === instanceId,
      );
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
  if (registeredWidgetInstances.size !== contract.defaultInstances.length) {
    throw new Error("Invalid Zen surface section binding");
  }
}

for (const surfaceId of [
  "surface.mission-control",
  "surface.hr.mission-control",
] as const satisfies readonly ZenV1SurfaceId[]) {
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
