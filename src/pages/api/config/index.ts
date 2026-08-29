import type { APIRoute } from "astro";
import { db, configs, users } from "@/lib/db";
import { v4 as uuidv4 } from "uuid";
import { eq, sql } from "drizzle-orm";
import { createSecureErrorResponse } from "@/lib/utils";
import { 
  mapUiToDbConfig, 
  mapDbToUiConfig, 
  mapUiScheduleToDb, 
  mapUiCleanupToDb,
  mapDbScheduleToUi,
  mapDbCleanupToUi,
  mapUiToDbGitlabConfig,
  mapDbToUiGitlabConfig,
  resolveGitlabConfigIntent
} from "@/lib/utils/config-mapper";
import { validateOutboundUrl } from "@/lib/utils/outbound-url";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import { createDefaultConfig } from "@/lib/utils/config-defaults";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { notificationConfigSchema, gitlabConfigSchema } from "@/lib/db/schema";

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    const body = await request.json();
    const {
      githubConfig,
      // Optional: absent or null means "keep whatever is stored", so an older
      // client saving an unrelated section cannot wipe a GitLab source.
      gitlabConfig,
      giteaConfig,
      scheduleConfig,
      cleanupConfig,
      mirrorOptions,
      advancedOptions,
      notificationConfig,
    } = body;

    if (!githubConfig || !giteaConfig || !scheduleConfig || !cleanupConfig || !mirrorOptions || !advancedOptions) {
      return new Response(
        JSON.stringify({
          success: false,
          message:
            "githubConfig, giteaConfig, scheduleConfig, cleanupConfig, mirrorOptions, and advancedOptions are required.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    let validatedNotificationConfig: any = undefined;
    if (notificationConfig !== undefined) {
      const parsed = notificationConfigSchema.safeParse(notificationConfig);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({
            success: false,
            message: `Invalid notificationConfig: ${parsed.error.message}`,
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      validatedNotificationConfig = parsed.data;
    }

    // Absent / null / present mean keep / remove / set — see the intent helper.
    const gitlabIntent = resolveGitlabConfigIntent(gitlabConfig);

    // Validated before any database work: an invalid instance URL stored here
    // would only surface much later inside a scheduled sync, and the scheduler
    // fetches this URL, so it gets the same SSRF check as the connection test.
    let validatedGitlabInput: Record<string, any> | null = null;
    if (gitlabIntent.action === "set") {
      const parsed = gitlabConfigSchema.safeParse(gitlabIntent.value);
      if (!parsed.success) {
        return new Response(
          JSON.stringify({
            success: false,
            message: `Invalid gitlabConfig: ${parsed.error.message}`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const urlCheck = validateOutboundUrl(parsed.data.url);
      if (!urlCheck.ok) {
        return new Response(
          JSON.stringify({
            success: false,
            message: `Invalid gitlabConfig URL: ${urlCheck.reason}`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      validatedGitlabInput = parsed.data;
    }

    // Validate Gitea URL format and protocol
    if (giteaConfig.url) {
      try {
        const giteaUrl = new URL(giteaConfig.url);
        if (!['http:', 'https:'].includes(giteaUrl.protocol)) {
          return new Response(
            JSON.stringify({ success: false, message: "Gitea URL must use http or https protocol." }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: "Invalid Gitea URL format." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Fetch existing config — prefer the active config; fall back to most-recently-updated
    // so a stale inactive stub never wins over a populated active row (see issue #271).
    const existingConfigResult = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    const existingConfig = existingConfigResult[0];

    // Parse the stored configs once — used both to preserve fields the
    // Configuration form doesn't expose (e.g. env-configured mirrorInterval,
    // see issue #338) and to preserve tokens when the form submits them empty.
    let existingGithub: Record<string, any> | undefined;
    let existingGitea: Record<string, any> | undefined;
    let existingGitlab: Record<string, any> | undefined;
    if (existingConfig) {
      try {
        existingGithub =
          typeof existingConfig.githubConfig === "string"
            ? JSON.parse(existingConfig.githubConfig)
            : existingConfig.githubConfig;

        existingGitea =
          typeof existingConfig.giteaConfig === "string"
            ? JSON.parse(existingConfig.giteaConfig)
            : existingConfig.giteaConfig;

        existingGitlab =
          typeof existingConfig.gitlabConfig === "string"
            ? JSON.parse(existingConfig.gitlabConfig)
            : (existingConfig.gitlabConfig ?? undefined);
      } catch (parseError) {
        console.error("Failed to parse existing config:", parseError);
      }
    }

    // Map UI structure to database schema structure first
    const { githubConfig: mappedGithubConfig, giteaConfig: mappedGiteaConfig } = mapUiToDbConfig(
      githubConfig,
      giteaConfig,
      mirrorOptions,
      advancedOptions,
      { githubConfig: existingGithub, giteaConfig: existingGitea }
    );

    // The stored GitLab token is already encrypted; decrypt it so the mapper's
    // "empty token means keep the old one" rule compares like with like.
    let existingGitlabDecrypted: Record<string, any> | undefined = existingGitlab;
    if (existingGitlab?.token) {
      try {
        existingGitlabDecrypted = {
          ...existingGitlab,
          token: decrypt(existingGitlab.token),
        };
      } catch (tokenError) {
        console.error("Failed to decrypt stored GitLab token:", tokenError);
      }
    }

    let mappedGitlabConfig: any = null;
    if (gitlabIntent.action === "keep") {
      mappedGitlabConfig = existingGitlabDecrypted ?? null;
    } else if (gitlabIntent.action === "set") {
      // Shape and URL were already validated above; merge in the stored token
      // so an empty field keeps the existing credential.
      const merged = mapUiToDbGitlabConfig(
        { ...validatedGitlabInput, ...gitlabIntent.value } as any,
        existingGitlabDecrypted as any
      );
      // A whitespace-only token is not a configured source.
      mappedGitlabConfig = merged
        ? { ...merged, token: (merged.token ?? "").trim() }
        : null;
    }

    // Preserve tokens if fields are empty
    try {
      // Decrypt existing tokens before preserving
      if (!mappedGithubConfig.token && existingGithub?.token) {
        mappedGithubConfig.token = decrypt(existingGithub.token);
      }

      if (!mappedGiteaConfig.token && existingGitea?.token) {
        mappedGiteaConfig.token = decrypt(existingGitea.token);
      }
    } catch (tokenError) {
      console.error("Failed to preserve tokens:", tokenError);
    }

    // Encrypt tokens before saving
    if (mappedGithubConfig.token) {
      mappedGithubConfig.token = encrypt(mappedGithubConfig.token);
    }

    if (mappedGiteaConfig.token) {
      mappedGiteaConfig.token = encrypt(mappedGiteaConfig.token);
    }

    if (mappedGitlabConfig?.token) {
      mappedGitlabConfig.token = encrypt(mappedGitlabConfig.token);
    }

    // Map schedule and cleanup configs to database schema
    const processedScheduleConfig = mapUiScheduleToDb(
      scheduleConfig,
      existingConfig ? existingConfig.scheduleConfig : undefined
    );
    const processedCleanupConfig = mapUiCleanupToDb(cleanupConfig);

    // Process notification config if provided
    let processedNotificationConfig: any = undefined;
    if (validatedNotificationConfig) {
      processedNotificationConfig = { ...validatedNotificationConfig };
      // Encrypt ntfy token if present
      if (processedNotificationConfig.ntfy?.token) {
        processedNotificationConfig.ntfy = {
          ...processedNotificationConfig.ntfy,
          token: encrypt(processedNotificationConfig.ntfy.token),
        };
      }
      // Encrypt apprise token if present
      if (processedNotificationConfig.apprise?.token) {
        processedNotificationConfig.apprise = {
          ...processedNotificationConfig.apprise,
          token: encrypt(processedNotificationConfig.apprise.token),
        };
      }
      // Encrypt gotify token if present
      if (processedNotificationConfig.gotify?.token) {
        processedNotificationConfig.gotify = {
          ...processedNotificationConfig.gotify,
          token: encrypt(processedNotificationConfig.gotify.token),
        };
      }
      // Encrypt webhook secret if present
      if (processedNotificationConfig.webhook?.secret) {
        processedNotificationConfig.webhook = {
          ...processedNotificationConfig.webhook,
          secret: encrypt(processedNotificationConfig.webhook.secret),
        };
      }
    }

    if (existingConfig) {
      // Update path
      const updateFields: Record<string, any> = {
        githubConfig: mappedGithubConfig,
        giteaConfig: mappedGiteaConfig,
        scheduleConfig: processedScheduleConfig,
        cleanupConfig: processedCleanupConfig,
        updatedAt: new Date(),
      };
      // "keep" leaves the column untouched; "remove" writes NULL so a user can
      // actually drop a compromised connection; "set" writes the new value.
      if (gitlabIntent.action === "remove") {
        updateFields.gitlabConfig = null;
      } else if (mappedGitlabConfig) {
        updateFields.gitlabConfig = mappedGitlabConfig;
      }
      if (processedNotificationConfig) {
        updateFields.notificationConfig = processedNotificationConfig;
      }
      await db
        .update(configs)
        .set(updateFields)
        .where(eq(configs.id, existingConfig.id));

      return new Response(
        JSON.stringify({
          success: true,
          message: "Configuration updated successfully",
          configId: existingConfig.id,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Fallback user check (optional if you're always passing userId)
    const userExists = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (userExists.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Invalid userId. No matching user found.",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Create new config
    const configId = uuidv4();
    const insertValues: Record<string, any> = {
      id: configId,
      userId,
      name: "Default Configuration",
      isActive: true,
      githubConfig: mappedGithubConfig,
      gitlabConfig: mappedGitlabConfig,
      giteaConfig: mappedGiteaConfig,
      include: [],
      exclude: [],
      scheduleConfig: processedScheduleConfig,
      cleanupConfig: processedCleanupConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (processedNotificationConfig) {
      insertValues.notificationConfig = processedNotificationConfig;
    }
    await db.insert(configs).values(insertValues);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Configuration created successfully",
        configId,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return createSecureErrorResponse(error, "config save", 500);
  }
};

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;
    const userId = authResult.userId;

    // Fetch the configuration for the user — prefer the active config; fall back to
    // most-recently-updated so a stale inactive stub never wins over a populated
    // active row (see issue #271).
    const config = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (config.length === 0) {
      // Create default configuration for the user
      const defaultConfig = await createDefaultConfig({ userId });
      
      // Map the created config to UI format
      const uiConfig = mapDbToUiConfig(defaultConfig);
      const uiScheduleConfig = mapDbScheduleToUi(defaultConfig.scheduleConfig);
      const uiCleanupConfig = mapDbCleanupToUi(defaultConfig.cleanupConfig);

      return new Response(
        JSON.stringify({
          ...defaultConfig,
          ...uiConfig,
          gitlabConfig: mapDbToUiGitlabConfig(defaultConfig),
          scheduleConfig: uiScheduleConfig,
          cleanupConfig: uiCleanupConfig,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Map database structure to UI structure
    const dbConfig = config[0];
    
    // Decrypt tokens before sending to UI
    try {
      const githubConfig = typeof dbConfig.githubConfig === "string"
        ? JSON.parse(dbConfig.githubConfig)
        : dbConfig.githubConfig;
      
      const giteaConfig = typeof dbConfig.giteaConfig === "string"
        ? JSON.parse(dbConfig.giteaConfig)
        : dbConfig.giteaConfig;
      
      const gitlabConfig = typeof dbConfig.gitlabConfig === "string"
        ? JSON.parse(dbConfig.gitlabConfig)
        : dbConfig.gitlabConfig;

      // Decrypt tokens
      if (githubConfig.token) {
        githubConfig.token = decrypt(githubConfig.token);
      }

      if (giteaConfig.token) {
        giteaConfig.token = decrypt(giteaConfig.token);
      }

      if (gitlabConfig?.token) {
        try {
          gitlabConfig.token = decrypt(gitlabConfig.token);
        } catch {
          // Clear on failure so the next save can't double-encrypt.
          gitlabConfig.token = "";
        }
      }

      // Create modified config with decrypted tokens
      const decryptedConfig = {
        ...dbConfig,
        githubConfig,
        gitlabConfig,
        giteaConfig
      };

      const uiConfig = mapDbToUiConfig(decryptedConfig);
      const uiGitlabConfig = mapDbToUiGitlabConfig(decryptedConfig);

      // Map schedule and cleanup configs to UI format
      const uiScheduleConfig = mapDbScheduleToUi(dbConfig.scheduleConfig);
      const uiCleanupConfig = mapDbCleanupToUi(dbConfig.cleanupConfig);

      // Decrypt notification config tokens
      let notificationConfig = dbConfig.notificationConfig;
      if (notificationConfig) {
        notificationConfig = { ...notificationConfig };
        if (notificationConfig.ntfy?.token) {
          try {
            notificationConfig.ntfy = { ...notificationConfig.ntfy, token: decrypt(notificationConfig.ntfy.token) };
          } catch {
            // Clear token on decryption failure to prevent double-encryption on next save
            notificationConfig.ntfy = { ...notificationConfig.ntfy, token: "" };
          }
        }
        if (notificationConfig.apprise?.token) {
          try {
            notificationConfig.apprise = { ...notificationConfig.apprise, token: decrypt(notificationConfig.apprise.token) };
          } catch {
            notificationConfig.apprise = { ...notificationConfig.apprise, token: "" };
          }
        }
        if (notificationConfig.gotify?.token) {
          try {
            notificationConfig.gotify = { ...notificationConfig.gotify, token: decrypt(notificationConfig.gotify.token) };
          } catch {
            notificationConfig.gotify = { ...notificationConfig.gotify, token: "" };
          }
        }
        if (notificationConfig.webhook?.secret) {
          try {
            notificationConfig.webhook = { ...notificationConfig.webhook, secret: decrypt(notificationConfig.webhook.secret) };
          } catch {
            notificationConfig.webhook = { ...notificationConfig.webhook, secret: "" };
          }
        }
      }

      return new Response(JSON.stringify({
        ...dbConfig,
        ...uiConfig,
        gitlabConfig: uiGitlabConfig,
        scheduleConfig: {
          ...uiScheduleConfig,
          lastRun: dbConfig.scheduleConfig.lastRun,
          nextRun: dbConfig.scheduleConfig.nextRun,
        },
        cleanupConfig: {
          ...uiCleanupConfig,
          lastRun: dbConfig.cleanupConfig.lastRun,
          nextRun: dbConfig.cleanupConfig.nextRun,
        },
        notificationConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Failed to decrypt tokens:", error);
      // Return config without decrypting tokens if there's an error
      const uiConfig = mapDbToUiConfig(dbConfig);
      const uiScheduleConfig = mapDbScheduleToUi(dbConfig.scheduleConfig);
      const uiCleanupConfig = mapDbCleanupToUi(dbConfig.cleanupConfig);

      return new Response(JSON.stringify({
        ...dbConfig,
        ...uiConfig,
        scheduleConfig: {
          ...uiScheduleConfig,
          lastRun: dbConfig.scheduleConfig.lastRun,
          nextRun: dbConfig.scheduleConfig.nextRun,
        },
        cleanupConfig: {
          ...uiCleanupConfig,
          lastRun: dbConfig.cleanupConfig.lastRun,
          nextRun: dbConfig.cleanupConfig.nextRun,
        },
        notificationConfig: dbConfig.notificationConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    return createSecureErrorResponse(error, "config fetch", 500);
  }
};
