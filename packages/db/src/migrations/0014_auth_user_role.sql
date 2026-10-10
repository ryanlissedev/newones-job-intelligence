ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'recruiter' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_check" CHECK ("role" IN ('recruiter', 'operator', 'admin', 'approver'));
