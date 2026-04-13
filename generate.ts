import { $ } from "bun";

const dry = process.argv.includes("--dry");

// MANAGED_PROVIDERS is a comma-separated allowlist of provider names this
// fork actively publishes (e.g. "mimir,foo,bar"). When set, generate.ts
// skips every metadata/<name>.toml whose name is not in the list. This
// lets us sync metadata/ from anomalyco/provider upstream without picking
// up their entire provider catalog — we only publish what we explicitly
// opt in to. Empty/unset = process every metadata file (upstream behavior).
const managed = (process.env.MANAGED_PROVIDERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const file of new Bun.Glob("*").scanSync("metadata")) {
  const provider = await import(`./metadata/${file}`);
  if (managed.length > 0 && !managed.includes(provider.name)) {
    console.log("skipping", provider.name, "not in MANAGED_PROVIDERS");
    continue;
  }
  const version = [provider.version, provider.suffix].filter(Boolean).join("-");
  const name = `@divmode/pulumi-${provider.name}`;
  const resp = await fetch(`https://registry.npmjs.org/${name}/${version}`);
  if (resp.status !== 404) {
    console.log("skipping", name, "version", version, "already exists");
    continue;
  }
  console.log("generating", name, "version", version);
  const result =
    await $`pulumi package add terraform-provider ${provider.terraform} ${provider.version}`;
  const output = result.stdout.toString();
  const sdksPath = output.match(/at (\/[^\n]+)/)?.at(1);
  const packageName = output.match(/for the (\S+) package/)?.at(1);
  if (!sdksPath || !packageName) {
    console.log("failed to parse output");
    continue;
  }
  const path = `${sdksPath}/${packageName}`;
  console.log("path", path);
  process.chdir(path);

  const pkg = Bun.file("package.json");
  const json = await pkg.json();
  json.name = name;
  json.version = provider.version;
  json.files = ["bin/", "README.md", "LICENSE"];
  json.repository = {
    type: "git",
    url: "https://github.com/DivMode/provider",
  };
  if (provider.suffix) json.version += "-" + provider.suffix;
  await Bun.write(pkg, JSON.stringify(json, null, 2));

  const tsconfig = Bun.file("tsconfig.json");
  const tsjson = Bun.JSONC.parse(await tsconfig.text());
  tsjson.compilerOptions.skipLibCheck = true;
  await Bun.write(tsconfig, JSON.stringify(tsjson, null, 2));

  await $`bun install && bun run build`;
  // --provenance attaches an OIDC-signed provenance attestation to the
  // published version. Requires id-token: write on the workflow and
  // NODE_AUTH_TOKEN unset so npm uses the OIDC token instead of a
  // static auth token. Trust is configured per-package via `npm trust`.
  if (!dry) await $`npm publish --access public --provenance`;
}
