import {
  type PresentationServiceGroupDiscovery,
  parseApiProblemDetails,
  parsePresentationServiceGroupDiscovery,
} from "@esbla/contracts";

export class PresentationServiceGroupsError extends Error {
  constructor() {
    super("Presentation service groups are unavailable");
    this.name = "PresentationServiceGroupsError";
  }
}

export async function decodePresentationServiceGroupDiscoveryResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationServiceGroupDiscovery> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationServiceGroupsError();
  }
  if (response.status !== 200) {
    try {
      parseApiProblemDetails(await response.json());
    } catch {}
    throw new PresentationServiceGroupsError();
  }
  try {
    return parsePresentationServiceGroupDiscovery(await response.json());
  } catch {
    throw new PresentationServiceGroupsError();
  }
}
