import type { Organization, RepoProvider } from "@/lib/db/schema";
import { z } from "zod";
import type { RepoStatus } from "./Repository";

export const membershipRoleEnum = z.enum([
  "member",
  "admin",
  "owner",
  "billing_manager",
]);

export type MembershipRole = z.infer<typeof membershipRoleEnum>;

export interface OrganizationsApiSuccessResponse {
  success: true;
  message: string;
  organizations: Organization[];
}

export interface OrganizationsApiErrorResponse {
  success: false;
  error: string;
  message?: string;
}

export type OrganizationsApiResponse =
  | OrganizationsApiSuccessResponse
  | OrganizationsApiErrorResponse;

export interface GitOrg {
  name: string;
  provider: RepoProvider;
  avatarUrl: string;
  membershipRole: MembershipRole;
  isIncluded: boolean;
  status: RepoStatus;
  repositoryCount: number;
  publicRepositoryCount?: number;
  privateRepositoryCount?: number;
  forkRepositoryCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddOrganizationApiRequest {
  userId: string;
  org: string;
  role: MembershipRole;
  force?: boolean;
}

export interface AddOrganizationApiResponse {
  success: boolean;
  message: string;
  organization?: Organization;
  error?: string;
}
