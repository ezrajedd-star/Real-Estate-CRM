import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@crm/domain';

export const PUBLIC = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const STEP_UP = 'stepUp';
export const SKIP_CSRF = 'skipCsrf';

/** Route needs no session (login, callback, health). */
export const Public = () => SetMetadata(PUBLIC, true);

/** Caller must hold ALL listed permissions (in at least one scope). Object scope is checked in services + RLS. */
export const Can = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Caller must have re-authenticated recently (STEP_UP_MAX_AGE_SECONDS). */
export const StepUp = () => SetMetadata(STEP_UP, true);

/** Only for routes that are cross-site by design (the IdP redirect back). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
