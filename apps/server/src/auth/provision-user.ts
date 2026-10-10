import {
  AUTH_EMAIL_PASSWORD_OPTIONS,
  AUTH_USER_ROLE_FIELD,
} from "@ji/auth/security-config";

import {
  formatProvisioningOutput,
  parseProvisioningEnvironment,
  provisionAuthUser,
  ProvisioningFailureError,
} from "./provisioning";

const writeOutput = (output: string): void => {
  process.stdout.write(`${output}\n`);
};

const main = async (): Promise<void> => {
  if (process.argv.length > 2) {
    writeOutput(
      JSON.stringify({ code: "ARGUMENTS_NOT_ALLOWED", status: "refused" })
    );
    process.exitCode = 1;
    return;
  }

  const parsed = parseProvisioningEnvironment({
    AUTH_BOOTSTRAP_CONFIRM: process.env.AUTH_BOOTSTRAP_CONFIRM,
    AUTH_BOOTSTRAP_EMAIL: process.env.AUTH_BOOTSTRAP_EMAIL,
    AUTH_BOOTSTRAP_ENABLED: process.env.AUTH_BOOTSTRAP_ENABLED,
    AUTH_BOOTSTRAP_NAME: process.env.AUTH_BOOTSTRAP_NAME,
    AUTH_BOOTSTRAP_PASSWORD: process.env.AUTH_BOOTSTRAP_PASSWORD,
    AUTH_BOOTSTRAP_ROLE: process.env.AUTH_BOOTSTRAP_ROLE,
  });
  if (!parsed.ok) {
    writeOutput(
      formatProvisioningOutput({ code: parsed.code, status: "refused" })
    );
    process.exitCode = 1;
    return;
  }

  let closeDatabase: (() => Promise<void>) | undefined;
  let operationSucceeded = false;
  try {
    const [databaseModule, authSchema, environmentModule, authModule, adapter] =
      await Promise.all([
        import("@ji/db"),
        import("@ji/db/schema/auth"),
        import("@ji/env/server"),
        import("better-auth"),
        import("better-auth/adapters/drizzle"),
      ]);
    const { closeDb, db } = databaseModule;
    closeDatabase = closeDb;
    const { env } = environmentModule;
    const { betterAuth } = authModule;
    const { drizzleAdapter } = adapter;
    const provisioner = betterAuth({
      appName: "Newones Auth Provisioner",
      baseURL: env.BETTER_AUTH_URL,
      database: drizzleAdapter(db, {
        provider: "pg",
        schema: authSchema,
      }),
      emailAndPassword: {
        ...AUTH_EMAIL_PASSWORD_OPTIONS,
        autoSignIn: false,
        disableSignUp: false,
      },
      logger: { disabled: true },
      secret: env.BETTER_AUTH_SECRET,
      trustedOrigins: [env.CORS_ORIGIN],
      user: {
        additionalFields: {
          role: {
            ...AUTH_USER_ROLE_FIELD,
            defaultValue: parsed.input.role,
          },
        },
      },
    });
    const evidence = await provisionAuthUser(parsed.input, {
      createUser: async (credentials) => {
        const created = await provisioner.api.signUpEmail({
          body: credentials,
        });
        return { id: created.user.id };
      },
      findUserByEmail: async (email) => {
        const stored = await db.query.user.findFirst({
          columns: { id: true, role: true },
          where: (users, { eq }) => eq(users.email, email),
        });
        return stored ?? null;
      },
    });
    writeOutput(formatProvisioningOutput(evidence));
    operationSucceeded = true;
    if (evidence.status === "provisioned") {
      process.exitCode = 0;
    } else if (evidence.status === "already_exists") {
      process.exitCode = 2;
    } else {
      process.exitCode = 3;
    }
  } catch (error) {
    const code =
      error instanceof ProvisioningFailureError ? error.code : "CREATE_FAILED";
    writeOutput(formatProvisioningOutput({ code, status: "refused" }));
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabase?.();
    } catch {
      if (operationSucceeded) {
        process.stderr.write(
          `${JSON.stringify({ code: "DATABASE_CLOSE_FAILED", status: "warning" })}\n`
        );
      } else {
        process.exitCode = 1;
      }
    }
  }
};

await main();
