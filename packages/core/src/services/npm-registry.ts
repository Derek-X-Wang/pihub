import { Context, Effect, Layer, Ref } from "effect";
import { NpmVersionNotFoundError, SourceFetchError } from "../errors.js";

const REGISTRY_BASE = "https://registry.npmjs.org";

export interface TarballInfo {
  readonly version: string;
  readonly tarballUrl: string;
  readonly bytes: Uint8Array;
}

export interface NpmRegistryShape {
  /** Returns the `dist-tags.latest` version string. */
  readonly resolveLatest: (packageName: string) => Effect.Effect<string, SourceFetchError>;
  /** Downloads the `.tgz` tarball for `<package>@<version>` and returns bytes. */
  readonly downloadTarball: (
    packageName: string,
    version: string,
  ) => Effect.Effect<TarballInfo, SourceFetchError | NpmVersionNotFoundError>;
}

const encodePackage = (name: string): string => name.replace("/", "%2F");

export class NpmRegistry extends Context.Tag("NpmRegistry")<NpmRegistry, NpmRegistryShape>() {
  static readonly Live = Layer.succeed(NpmRegistry, {
    resolveLatest: (packageName) =>
      Effect.gen(function* () {
        const url = `${REGISTRY_BASE}/${encodePackage(packageName)}`;
        const res = yield* Effect.tryPromise({
          try: () => fetch(url),
          catch: (e) =>
            new SourceFetchError({
              source: `npm:${packageName}`,
              message: `metadata fetch threw: ${String(e)}`,
            }),
        });
        if (!res.ok) {
          return yield* Effect.fail(
            new SourceFetchError({
              source: `npm:${packageName}`,
              message: `GET ${url} failed: ${res.status} ${res.statusText}`,
            }),
          );
        }
        const body = yield* Effect.tryPromise({
          try: () =>
            res.json() as Promise<{
              "dist-tags"?: { latest?: unknown };
            }>,
          catch: (e) =>
            new SourceFetchError({
              source: `npm:${packageName}`,
              message: `metadata JSON decode failed: ${String(e)}`,
            }),
        });
        const latest = body["dist-tags"]?.latest;
        if (typeof latest !== "string" || latest.length === 0) {
          return yield* Effect.fail(
            new SourceFetchError({
              source: `npm:${packageName}`,
              message: "registry response missing dist-tags.latest",
            }),
          );
        }
        return latest;
      }),

    downloadTarball: (packageName, version) =>
      Effect.gen(function* () {
        const metaUrl = `${REGISTRY_BASE}/${encodePackage(packageName)}/${version}`;
        const metaRes = yield* Effect.tryPromise({
          try: () => fetch(metaUrl),
          catch: (e) =>
            new SourceFetchError({
              source: `npm:${packageName}@${version}`,
              message: `version metadata fetch threw: ${String(e)}`,
            }),
        });
        if (metaRes.status === 404) {
          return yield* Effect.fail(
            new NpmVersionNotFoundError({
              packageName,
              version,
              message: `version not found on registry`,
            }),
          );
        }
        if (!metaRes.ok) {
          return yield* Effect.fail(
            new SourceFetchError({
              source: `npm:${packageName}@${version}`,
              message: `GET ${metaUrl} failed: ${metaRes.status} ${metaRes.statusText}`,
            }),
          );
        }
        const body = yield* Effect.tryPromise({
          try: () => metaRes.json() as Promise<{ dist?: { tarball?: unknown } }>,
          catch: (e) =>
            new SourceFetchError({
              source: `npm:${packageName}@${version}`,
              message: `version JSON decode failed: ${String(e)}`,
            }),
        });
        const tarballUrl = body.dist?.tarball;
        if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
          return yield* Effect.fail(
            new SourceFetchError({
              source: `npm:${packageName}@${version}`,
              message: "version doc missing dist.tarball URL",
            }),
          );
        }
        const tgzRes = yield* Effect.tryPromise({
          try: () => fetch(tarballUrl),
          catch: (e) =>
            new SourceFetchError({
              source: tarballUrl,
              message: `tarball fetch threw: ${String(e)}`,
            }),
        });
        if (!tgzRes.ok) {
          return yield* Effect.fail(
            new SourceFetchError({
              source: tarballUrl,
              message: `GET tarball failed: ${tgzRes.status} ${tgzRes.statusText}`,
            }),
          );
        }
        const buf = yield* Effect.tryPromise({
          try: () => tgzRes.arrayBuffer(),
          catch: (e) =>
            new SourceFetchError({
              source: tarballUrl,
              message: `tarball read failed: ${String(e)}`,
            }),
        });
        return { version, tarballUrl, bytes: new Uint8Array(buf) };
      }),
  });

  /**
   * Test layer: a Ref-backed map of `<package>@<version>` to tarball bytes
   * plus a separate map from `<package>` to "latest" version. The fixture
   * tarball can be a tiny in-memory `.tgz` produced by the test harness.
   */
  static readonly Test = (
    seed: {
      readonly latest?: ReadonlyMap<string, string>;
      readonly tarballs?: ReadonlyMap<string, Uint8Array>;
    } = {},
  ) =>
    Layer.effect(
      NpmRegistry,
      Effect.gen(function* () {
        const latest = yield* Ref.make(new Map(seed.latest ?? new Map()));
        const tarballs = yield* Ref.make(new Map(seed.tarballs ?? new Map()));
        return {
          resolveLatest: (packageName) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(latest);
              const v = m.get(packageName);
              if (!v) {
                return yield* Effect.fail(
                  new SourceFetchError({
                    source: `npm:${packageName}`,
                    message: "no latest version seeded for this package in Test layer",
                  }),
                );
              }
              return v;
            }),
          downloadTarball: (packageName, version) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(tarballs);
              const bytes = m.get(`${packageName}@${version}`);
              if (!bytes) {
                return yield* Effect.fail(
                  new NpmVersionNotFoundError({
                    packageName,
                    version,
                    message: "no tarball seeded for this version in Test layer",
                  }),
                );
              }
              return {
                version,
                tarballUrl: `test://${packageName}/${version}.tgz`,
                bytes,
              };
            }),
        } satisfies NpmRegistryShape;
      }),
    );
}
