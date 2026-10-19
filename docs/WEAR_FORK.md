# WEAR_FORK — what this fork adds, how to build it, how to merge upstream

This repository is a **fork of openGym**, not a branch of it. It carries the phone half of the
Wear OS companion link described in `docs/protocol.md` of the *outer* project
(`F:\android\projects\opengym-wearos\`). The watch app is a separate project and is not here.

| | |
|---|---|
| Upstream | `https://github.com/DuarteSantos8/openGym.git` (branch `main`, remote `origin`) |
| Base commit | `464355ef43d4c8f8a4e0bb6db9c2af7f240593b5` — tag **v1.4.1** |
| Local branch | `main`, **with the wear changes uncommitted in the working tree** |

> [!IMPORTANT]
> **The wear changes are uncommitted working-tree edits.** `git checkout .`, `git stash`, a
> `git pull` with a dirty tree, or an accidental `--hard` destroys the whole phone-side bridge.
> **Commit them on a local branch before doing anything else with git.** Nothing about this fork
> currently requires a commit — the builds and tests all work off the working tree — which is
> exactly why it is easy to lose.

---

## 1. Build and install

One command, from the fork root:

```powershell
pwsh -File scripts/build-android.ps1                       # npm ci + web bundle + assembleDebug
pwsh -File scripts/build-android.ps1 -SkipNodeModules -SkipClean   # repeat build, fast
pwsh -File scripts/build-android.ps1 -Release              # release variant
```

It does the whole chain — `npm ci` → `npm run build:mobile` → `gradlew clean assembleDebug` — and
sets the environment up itself:

- `JAVA_HOME` falls back to `%USERPROFILE%\.jdks\jbr-21.0.11`, then to Android Studio's bundled JBR.
  **It must be a Windows path**; a `/c/...` path fails.
- `ANDROID_PREFS_ROOT` is cleared. AGP aborts when both `ANDROID_PREFS_ROOT` and `ANDROID_USER_HOME`
  are set, which happens in shells spawned by Android Studio.
- `ANDROID_HOME` falls back to `%LOCALAPPDATA%\Android\Sdk`.
- `local.properties` in `frontend/android/` is created if missing (`sdk.dir`).

Manual equivalent, if the script is ever in the way:

```powershell
cd frontend
npm ci
npm run build:mobile
cd android
.\gradlew.bat assembleDebug
```

`build:mobile` used to fail on Windows — it used POSIX inline-env syntax (`VITE_MOBILE=1 vite build`).
The fork pins **`cross-env`** for it (`frontend/package.json`).

> [!WARNING]
> A **release** build keeps only `arm64-v8a` / `armeabi-v7a` native libraries, so a release APK will
> **not install on an x86_64 emulator**. Debug builds include x86_64 and are what the emulator rigs
> use. The real watch is 32-bit `armeabi-v7a`, so release is fine there.

Install:

```powershell
adb install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 2. Signing — mandatory, and it is why this fork exists in this shape

The Wearable Data Layer routes on **package name _and_ signing certificate**. The watch app and this
phone app must therefore be signed by the same key and carry matching application ids.

- `frontend/android/app/build.gradle` applies `keystore.gradle` from the `android/` root, which
  creates a signing config named `opengym` and assigns it to **both** `debug` and `release`.
- `frontend/android/keystore.properties` holds the credentials and is **gitignored**. It is copied
  by hand from the outer project's `keystore\keystore.properties` (`F:\android\projects\opengym-wearos\keystore\`).
- **When `keystore.properties` is absent the script does nothing** and AGP's default debug key is
  used, so the project still builds for anyone who does not have the shared key — it just cannot pair
  with the watch.

Two independent pairings, and they must not be crossed:

| Pairing | Phone applicationId | Watch applicationId | Use |
|---|---|---|---|
| Debug | `ch.duartesantos.opengym.test` | `ch.duartesantos.opengym.test` | emulators, and real-device work that must not touch Gus's real data |
| Release | `ch.duartesantos.opengym` | `ch.duartesantos.opengym` | the plain install |

The debug suffix comes from the upstream template's `debug { applicationIdSuffix ".test" }`, which is
load-bearing here rather than cosmetic: without it the debug phone app and the debug watch app would
not match. A `.test` watch never sees a release phone app, and that failure is **silent**.

Expected signer on both APKs:

```
SHA-256 c60a145c6cb289ac9774603c5f8fc1b9b347c6618e5b3b5b2f68a11311792813
```

Verify with `apksigner verify --print-certs <apk>`, or `./gradlew :app:signingReport` in
`frontend/android`.

---

## 3. What the fork adds — the exact surface an upstream merge has to reconcile

### 3.1 Modified tracked files (10)

| File | Change |
|---|---|
| `frontend/package.json` | `cross-env` dependency; `build:mobile` uses it |
| `frontend/package-lock.json` | the lockfile entry for it |
| `frontend/src/main.jsx` | one import, one call: `startWearLink()` — a no-op outside Android |
| `frontend/src/store/useStore.js` | two imports; `publishWear(S)` inside `persist` (**the single place the document is saved**, which is therefore the single place the mirror is told); the `applyWatchCommand(cmd, ui)` action |
| `frontend/android/app/build.gradle` | `apply from: rootProject.file('keystore.gradle')`; `play-services-wearable`; comments |
| `frontend/android/variables.gradle` | `playServicesWearableVersion = '19.0.0'` (newest release resolving against compileSdk 35) |
| `frontend/android/app/src/main/AndroidManifest.xml` | `.WearDataLayerService` (exported, filtered to `/opengym/wear`) and `.WearSessionService` (`specialUse` foreground) |
| `frontend/android/app/src/main/res/values/strings.xml` | the foreground service's notification strings |
| `frontend/android/app/src/main/java/ch/duartesantos/opengym/MainActivity.java` | bridge registration |
| `frontend/android/.gitignore` | ignores `keystore.properties` |

### 3.2 New files (untracked)

- **JS — the protocol, pure and unit-testable**: `frontend/src/lib/wear-frames.js` (frame
  encode/decode), `wear-projection.js` (openGym's document → the watch's ~12 fields),
  `wear-commands.js` (apply a watch command through openGym's own helpers), `wear-link.js`
  (lifecycle, `rev`, retry, the Data Layer/TCP choice), `wear-session.js` (the workout-scoped
  foreground service), `wear-sink.js` (the publish hook `useStore` calls). Each has a `.test.js`
  beside it, plus `frontend/src/store/useStore.watch-command.test.jsx`.
- **Java**: `WearWire.java` (frame codec, mirrors `wear-frames.js`), `WearLink.java` (link state),
  `WearBridgePlugin.java` (the Capacitor plugin + the TCP relay), `WearDataLayer.java`,
  `WearDataLayerService.java` (**answers the watch from native code while the WebView is frozen**),
  `WearSessionService.java`, `WearStateCache.java` (persisted last-`state` file), `WearLinkPolicy.java`,
  `WearNodeSet.java`, plus unit tests for the last four.
- `frontend/android/keystore.gradle` — the signing wiring (canonical copy also lives in the outer
  project's `keystore\`).
- `scripts/build-android.ps1` — the one-command build.

Everything the fork adds is **additive and marked**: the modified files carry comments naming the
outer docs (`docs/notes/12-datalayer-decisions.md`, `docs/protocol.md`). That is deliberate — it is
what makes the rebase below mechanical rather than archaeological.

### 3.3 Two rules the phone side honours, and an upstream merge must not break

1. **`rev` is a per-epoch counter and is persisted** (`gym_wear_rev` in localStorage), and the phone
   sends a `hello` only when its *stored* state is genuinely new. This fixed a defect that reached
   real hardware: a `Page.reload` rewound `rev` to 1 while the Data Layer link stayed up, after which
   the watch dropped every `state` frame forever. See `docs/protocol.md` §5.2 and
   `docs/notes/18-rev-restart-fix.md`.
2. **A `state` is carried as a `DataItem` _and_ as a `Message`**, and the watch reads the current
   `DataItem` at startup rather than only listening for changes. A `DataItem`-only sender and a
   `Message`-only receiver never intersect, and the failure is silent — every health signal stays
   green. See `docs/notes/12-datalayer-decisions.md` §1a.

---

## 4. Tests

```powershell
cd frontend
npx vitest run                       # JS: the whole suite
cd android
.\gradlew.bat :app:testDebugUnitTest # Java: 42 tests
```

Expected noise, **pre-existing upstream, not the fork's**:

- `sheets.day-note.test.jsx` fails on clean upstream too (confirmed by `git stash` on a clean tree).
- `scripts/check-mobile-bundle.test.mjs` likewise.

Do not "fix" either of them as part of a merge; do confirm they are still the *only* failures.

---

## 5. Merging upstream

Because the wear changes are uncommitted, step 0 is not optional.

```powershell
# 0. COMMIT FIRST — otherwise the merge has nothing to replay and a conflict can eat the bridge
git checkout -b wear-bridge
git add -A
git commit -m "wear: phone-side bridge for the openGym Wear OS companion"

# 1. see what arrived
git fetch origin
git log --oneline HEAD..origin/main

# 2. replay the wear commits on top of it
git rebase origin/main
```

Conflict hotspots, in the order they are likely to appear:

| File | Why it conflicts | How to resolve |
|---|---|---|
| `frontend/src/store/useStore.js` | the biggest file in the app and the wear hooks are inside `persist` and the action table | keep both sides; the wear side is exactly one import pair, one `publishWear(S)` line after `set({ S })`, and the `applyWatchCommand` action |
| `frontend/src/main.jsx` | six lines long, and the change is +2 | keep both |
| `frontend/package.json` / `package-lock.json` | dependency churn | keep `cross-env`, then **re-run `npm install`** and let it rewrite the lockfile rather than resolving it by hand |
| `frontend/android/app/build.gradle` | upstream edits its `dependencies` block | keep the `apply from: …keystore.gradle` line, which must stay **before** `android { }` |
| `frontend/android/app/src/main/AndroidManifest.xml` | upstream adds components too | keep both service blocks; they are independent |
| `frontend/android/variables.gradle` | one `ext` line | keep `playServicesWearableVersion` |
| `frontend/android/app/src/main/res/values/strings.xml` | shared file, additive | keep both |

After the rebase:

```powershell
pwsh -File scripts/build-android.ps1 -SkipNodeModules -SkipClean   # must still compile
cd frontend; npx vitest run                                        # only the two known upstream failures
cd android; .\gradlew.bat :app:testDebugUnitTest                   # 42 green
apksigner verify --print-certs app\build\outputs\apk\debug\app-debug.apk   # signer must still be c60a14…
```

Then re-check the two rules in §3.3 against whatever upstream did to the store's save path — rule 1 in
particular depends on `publishWear`/`rev` being reached on every save, and an upstream refactor of
`persist` is the one plausible way to break the watch silently.

## 6. Where the contract lives

| Question | File (in the outer project `F:\android\projects\opengym-wearos\`) |
|---|---|
| Frame format, the seven commands, `rev`, retries, refusals | `docs/protocol.md` |
| The Data Layer decisions, package/signing pairing, and the two hardware bugs | `docs/notes/12-datalayer-decisions.md` |
| Why a phone-side foreground service exists at all (the WebView freeze) | `docs/notes/02-webview-background-liveness.md` |
| The hardware rig and its traps | `docs/STATUS.md` §4 and §6 |
| Current state of everything | `docs/STATUS.md` |
