import { StrataClient } from "@cloudcruise/strata"
import { ResolvedAuth } from "./auth.js"
import { clientIdentity } from "./client-identity.js"

export { ApiError } from "@cloudcruise/strata"

/** The strata client bound to a resolved CLI profile and the CLI's identity. */
export class ApiClient extends StrataClient {
  constructor(auth: ResolvedAuth) {
    super({
      baseUrl: auth.baseUrl,
      token: auth.token,
      authScheme: auth.authScheme,
      workspaceId: auth.workspaceId,
      ...clientIdentity()
    })
  }
}
