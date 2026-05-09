import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import { ProfileError } from "../errors.js";
import { Paths } from "../paths.js";

export interface ProfileShape {
  readonly ensure: (agentName: string) => Effect.Effect<void, ProfileError>;
}

export class Profile extends Context.Tag("Profile")<Profile, ProfileShape>() {
  static readonly Live = Layer.effect(
    Profile,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      return Profile.of({
        ensure: (agentName) =>
          fs.makeDirectory(paths.agentProfile(agentName), { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new ProfileError({
                  name: agentName,
                  message: `failed to create profile dir: ${String(e)}`,
                }),
            ),
          ),
      });
    }),
  );

  static readonly Test = () =>
    Layer.effect(
      Profile,
      Effect.gen(function* () {
        const created = yield* Ref.make(new Set<string>());
        return Profile.of({
          ensure: (agentName) => Ref.update(created, (s) => new Set([...s, agentName])),
        });
      }),
    );
}
