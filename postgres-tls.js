"use strict";

function postgresConnectionOptions(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (connectionString === undefined) {
    return { ssl: { rejectUnauthorized: true } };
  }

  let url;
  try {
    url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) {
      throw new Error();
    }
    decodeURIComponent(url.hostname);
    decodeURIComponent(url.pathname);
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error("INVALID_DATABASE_URL");
  }

  for (const key of [...url.searchParams.keys()]) {
    if (["host", "hostaddr", "port"].includes(key.toLowerCase())) {
      throw new Error("INVALID_DATABASE_URL_ROUTING");
    }
    // pg otherwise lets SSL query options replace the explicit pool policy.
    if (/^(ssl|uselibpqcompat$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }

  const allowInternalCertificate =
    env.VIDEAPILOT_STAGING_INTERNAL_DB_TLS === "true" &&
    env.VIDEAPILOT_ENVIRONMENT === "staging" &&
    /^dpg-[a-z0-9]+-a$/.test(url.hostname) &&
    (!url.port || url.port === "5432") &&
    url.pathname === "/videapilot_staging";

  return {
    connectionString: url.href,
    ssl: { rejectUnauthorized: !allowInternalCertificate },
  };
}

module.exports = { postgresConnectionOptions };
