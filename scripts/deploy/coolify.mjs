import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  apiRequest,
  deploymentConfig,
  deploymentEnvironment,
  initialAdmin,
  projectRoot,
  writeJson,
} from "./common.mjs";

const config = await deploymentConfig();
if (
  !config.githubAppUuid || config.githubAppUuid.startsWith("REPLACE_") ||
  !config.repository || config.repository.startsWith("REPLACE_")
) {
  throw new Error("Configure a private repository and its Coolify GitHub App in the ignored deployment target file");
}
const credentialLines = (await readFile(path.resolve(projectRoot, config.apiBaseFile), "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const token = process.env.COOLIFY_API_TOKEN || credentialLines[0];
const base = process.env.COOLIFY_API_BASE || credentialLines.find((line) => line.startsWith("http"));
if (!token || !base) throw new Error("Coolify API token/base URL is not configured");

let state = {};
try {
  state = await readJson("deploy/.state.json");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const applications = await apiRequest(base, token, "/applications");
let application = applications.find((item) => item.uuid === state.applicationUuid)
  ?? applications.find((item) => item.git_repository === config.repository);

if (!application) {
  const created = await apiRequest(
    base,
    token,
    "/applications/private-github-app",
    {
      method: "POST",
      body: JSON.stringify({
        project_uuid: config.projectUuid,
        server_uuid: config.serverUuid,
        environment_uuid: config.environmentUuid,
        github_app_uuid: config.githubAppUuid,
        git_repository: config.repository,
        git_branch: config.branch,
        ports_exposes: "8787",
        build_pack: "dockercompose",
        docker_compose_location: config.composeFile,
        name: "Locus Chat",
        description: "Private multi-user Locus Chat deployment",
        domains: `${config.domain},https://www.locuschat.io`,
        docker_compose_domains: [
          { name: "app", domain: `${config.domain},https://www.locuschat.io` },
        ],
        redirect: "non-www",
        instant_deploy: false,
      }),
    },
  );
  state.applicationUuid = created.uuid;
  await writeJson("deploy/.state.json", state);
  application = { uuid: created.uuid };
  console.log(`Created Coolify application ${created.uuid}`);
} else {
  state.applicationUuid = application.uuid;
  await writeJson("deploy/.state.json", state);
}

const applicationDetails = await apiRequest(base, token, `/applications/${application.uuid}`);
await apiRequest(base, token, `/applications/${application.uuid}`, {
  method: "PATCH",
  body: JSON.stringify({
    docker_compose_raw: Buffer.from(applicationDetails.docker_compose_raw, "utf8").toString("base64"),
    git_branch: config.branch,
    build_pack: "dockercompose",
    docker_compose_location: config.composeFile,
    domains: `${config.domain},https://www.locuschat.io`,
    docker_compose_domains: [
      { name: "app", domain: `${config.domain},https://www.locuschat.io` },
    ],
    redirect: "non-www",
    health_check_enabled: true,
    health_check_path: "/api/ready",
    health_check_port: "8787",
    health_check_method: "GET",
    health_check_return_code: 200,
    health_check_scheme: "http",
    health_check_interval: 15,
    health_check_timeout: 5,
    health_check_retries: 10,
    health_check_start_period: 30,
  }),
});

const secrets = await deploymentEnvironment();
const admin = await initialAdmin();
const environment = {
  ...secrets,
  LOCUS_MODE: "hosted",
  LOCUS_PUBLIC_ORIGIN: config.domain,
  METAPOST_SERVICE_URL: "http://metapost:8090",
  LOCUS_MAX_CONCURRENT_GENERATIONS: "3",
  LOCUS_BOOTSTRAP_TOKEN: admin.provisioned ? "" : admin.BOOTSTRAP_TOKEN,
};
await apiRequest(base, token, `/applications/${application.uuid}/envs/bulk`, {
  method: "PATCH",
  body: JSON.stringify({
    data: Object.entries(environment).map(([key, value]) => ({
      key,
      value,
      is_runtime: true,
      // Coolify uses build-time variables for Docker Compose interpolation before containers exist.
      // They remain runtime values and are not referenced by either Dockerfile.
      is_buildtime: true,
      is_preview: false,
      is_literal: true,
    })),
  }),
});

const deployment = await apiRequest(base, token, `/applications/${application.uuid}/restart`, {
  method: "POST",
});
console.log(`Deployment queued: ${deployment.deployment_uuid ?? "Coolify accepted the request"}`);
console.log(`Application UUID: ${application.uuid}`);
if (deployment.deployment_uuid) {
  state.deploymentUuid = deployment.deployment_uuid;
  await writeJson("deploy/.state.json", state);
}
