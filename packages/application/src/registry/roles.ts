export const ROLE_RECRUITER = "recruiter" as const;
export const ROLE_OPERATOR = "operator" as const;
export const ROLE_ADMIN = "admin" as const;
export const ROLE_APPROVER = "approver" as const;

export const PERM_SLICE_READ = "slice-a:read" as const;
export const PERM_APPROVAL = "approval" as const;
export const PERM_EXPORT = "export" as const;
/** Read-only marts analytics (Marktvragen / JI-DSH-07) — revocable apart from slice-a reads. */
export const PERM_MARTS_READ = "marts:read" as const;

export const sliceARoles = [
  ROLE_RECRUITER,
  ROLE_OPERATOR,
  ROLE_ADMIN,
  ROLE_APPROVER,
] as const;

export type SliceARole = (typeof sliceARoles)[number];

export const permissionsForRole = (role: SliceARole): ReadonlySet<string> => {
  switch (role) {
    case ROLE_ADMIN: {
      return new Set([
        PERM_SLICE_READ,
        PERM_MARTS_READ,
        PERM_APPROVAL,
        PERM_EXPORT,
        ROLE_RECRUITER,
        ROLE_OPERATOR,
        ROLE_ADMIN,
      ]);
    }
    case ROLE_APPROVER: {
      return new Set([
        PERM_SLICE_READ,
        PERM_MARTS_READ,
        PERM_APPROVAL,
        PERM_EXPORT,
      ]);
    }
    case ROLE_OPERATOR: {
      return new Set([PERM_SLICE_READ, PERM_MARTS_READ, ROLE_OPERATOR]);
    }
    case ROLE_RECRUITER: {
      return new Set([PERM_SLICE_READ, PERM_MARTS_READ, ROLE_RECRUITER]);
    }
    default: {
      const _exhaustive: never = role;
      throw new Error(`Unsupported role: ${String(_exhaustive)}`);
    }
  }
};

export const hasRecruiterPermission = (
  permissions: ReadonlySet<string>
): boolean => permissions.has(ROLE_RECRUITER);
