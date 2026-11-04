import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mods = ["spaces", "files", "changes", "worktree"];
const sources = new Map(await Promise.all(mods.map(async name => [name,
  (await readFile(new URL(`../defaults/mods/${name}/main.js`, import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "").replace(/export default class /g, "class ").replace(/^export /gm, ""),
] as const)));
const load = (name: string, exec: Function) => new Function("View", "exec", `${sources.get(name)}; return checkGit;`)(class {}, exec);
const reply = (code: number, stdout = "") => ({ code, stdout, stderr: "" });

for (const name of mods) {
  test(`${name}: only the user's own filter commands and exact LFS drivers are trusted`, async () => {
    for (const stdout of [
      "global\0filter.x.clean\nmy-clean\0",
      "local\0filter.lfs.smudge\ngit-lfs smudge --skip -- %f\0local\0filter.lfs.process\ngit-lfs filter-process --skip\0",
      "system\0filter.x.process\nmy-process\0",
      "local\0filter.lfs.clean\ngit-lfs clean -- %f\0local\0filter.lfs.smudge\ngit-lfs smudge -- %f\0worktree\0filter.lfs.process\ngit-lfs filter-process\0",
    ]) await load(name, async () => reply(0, stdout))("/repo", "cloud");
    await load(name, async () => reply(1))("/repo", null);
    for (const stdout of [
      "local\0filter.x.clean\nmy-clean\0",
      "worktree\0filter.x.process\nmy-process\0",
      "local\0filter.lfs.clean\ngit-lfs clean -- %f; touch marker\0",
      "local\0filter.lfs.clean\ngit-lfs clean -- %f\necho bad\0",
      "local\0lfs.extension.x.clean\nmy-clean\0",
      "local\0lfs.customtransfer.x.path\nmy-transfer\0",
      "global\0filter.x.clean\nokay\0local\0filter.x.clean\nnot-okay\0",
      "local\0filter.x.clean\nmy-clean",
    ]) await expect(load(name, async () => reply(0, stdout))("/repo", null)).rejects.toThrow();
    await expect(load(name, async () => reply(128))("/repo", null)).rejects.toThrow();
    await expect(load(name, async () => { throw new Error("offline"); })("/repo", "cloud")).rejects.toThrow();
  });

  test(`${name}: config inspection goes to the repo's machine, never runs status`, async () => {
    const calls: unknown[] = [];
    await load(name, async (command: string, args: string[], options: unknown) => {
      calls.push([command, args, options]); return reply(1);
    })("/repo", "cloud");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["git", ["--no-lazy-fetch", "version"], { on: "cloud" }]);
    expect(calls[1]).toEqual(["git", expect.arrayContaining(["config", "--includes", "--show-scope", "--null"]), { cwd: "/repo", on: "cloud" }]);
  });
}

for (const name of mods) {
  test(`${name}: older Git refuses promisor config at every scope and caches the probe per machine`, async () => {
    const probes: unknown[] = [];
    let config = "";
    const check = load(name, async (_command: string, args: string[], options: unknown) => {
      if (args.includes("version")) { probes.push(options); return reply(129); }
      return config ? reply(0, config) : reply(1);
    });
    await check("/repo", null);
    await check("/other", undefined);
    await check("/repo", "cloud");
    expect(probes).toEqual([{ on: null }, { on: "cloud" }]);
    for (const scope of ["local", "worktree", "global", "system", "command"]) {
      for (const key of ["remote.origin.promisor", "remote.origin.partialclonefilter", "extensions.partialclone"]) {
        config = `${scope}\0${key}\nfalse\0`;
        await expect(check("/repo", null)).rejects.toThrow();
      }
    }
    for (const key of ["remote.origin.promisor", "remote.origin.partialclonefilter", "extensions.partialclone"]) {
      const prefix = await load(name, async (_command: string, args: string[]) =>
        args.includes("version") ? reply(0) : reply(0, `local\0${key}\nblob:none\0`)
      )("/repo", null);
      expect(prefix).toContain("--no-lazy-fetch");
    }
    config = "";
    const prefix = await check("/repo", null);
    expect(prefix).not.toContain("--no-lazy-fetch");
  });
}

test("a copied partial clone cannot run its uploadpack when Changes reads a missing object", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-lazy-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "global") };
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, env });
  const check = load("changes", async (_command: string, args: string[]) => {
    const r = git(...args); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  });
  try {
    git("init", "-q");
    await writeFile(join(root, "tracked"), "before\n");
    git("add", "tracked");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    await writeFile(join(root, "tracked"), "after\n");
    const blob = git("rev-parse", "HEAD:tracked").stdout.toString().trim();
    const marker = join(root, "EXECUTED");
    for (const [k, v] of [["remote.origin.url", root], ["remote.origin.promisor", "true"], ["remote.origin.uploadpack", `touch '${marker}'; false`]]) git("config", k, v);
    await rm(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    // Without the guard flags, this diff fetches the blob and runs uploadpack.
    git("diff", "HEAD", "--numstat");
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    if (git("--no-lazy-fetch", "version").exitCode === 0) {
      const READ = await check(root, null);
      git(...READ, "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "HEAD", "--numstat", "-z", "--no-renames");
    } else await expect(check(root, null)).rejects.toThrow();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the folder watcher cannot lazy-fetch a missing skip-worktree ignore blob", async () => {
  await fixture(async (root, git) => {
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub/.gitignore"), "build/\n");
    expect(git("add", "sub/.gitignore").code).toBe(0);
    const blob = git("rev-parse", ":sub/.gitignore").stdout.trim();
    expect(git("update-index", "--skip-worktree", "sub/.gitignore").code).toBe(0);
    await rm(join(root, "sub/.gitignore"));
    await writeFile(join(root, "sub/untracked"), "untracked\n");
    const marker = join(root, "EXECUTED");
    for (const [key, value] of [
      ["remote.origin.url", root], ["remote.origin.promisor", "true"],
      ["remote.origin.uploadpack", `touch '${marker}'; false`], ["protocol.file.allow", "always"],
    ]) expect(git("config", key, value).code).toBe(0);
    await rm(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const args = ["-C", root, "-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"];
    git(...args);
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "global"), GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("partialclonefilter alone cannot run uploadpack during Changes refresh", async () => {
  await fixture(async (root, git, exec) => {
    const marker = join(root, "EXECUTED");
    const blob = git("rev-parse", "HEAD:tracked").stdout.trim();
    await writeFile(join(root, "tracked"), "after\n");
    for (const [key, value] of [
      ["remote.origin.url", root], ["remote.origin.partialclonefilter", "blob:none"],
      ["remote.origin.uploadpack", `touch '${marker}'; false`],
    ]) expect(git("config", key, value).code).toBe(0);
    await rm(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    const { refresh } = changesView(root, exec);
    await refresh();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("filter repos keep Spaces branch counts and Worktree New/Open, but refuse Remove and diffs", async () => {
  await fixture(async (root, git, exec) => {
    const marker = join(root, "EXECUTED");
    const branch = git("symbolic-ref", "--short", "HEAD").stdout.trim();
    expect(git("branch", "upstream").code).toBe(0);
    expect(git("branch", "--set-upstream-to=upstream", branch).code).toBe(0);
    await writeFile(join(root, ".gitattributes"), "tracked filter=x\n");
    expect(git("add", ".gitattributes").code).toBe(0);
    expect(git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "ahead").code).toBe(0);
    const upstream = git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", "HEAD^{tree}", "-p", "upstream", "-m", "behind");
    expect(upstream.code).toBe(0);
    expect(git("update-ref", "refs/heads/upstream", upstream.stdout.trim()).code).toBe(0);
    await writeFile(join(root, "tracked"), "after with a different size\n");
    expect(git("config", "filter.x.clean", `touch '${marker}'; cat`).code).toBe(0);
    git("diff", "HEAD");
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    const calls: string[][] = [];
    const trackedExec = async (cmd: string, args: string[], options: any) => { calls.push(args); return exec(cmd, args, options); };
    const Spaces = new Function("View", "exec", `${sources.get("spaces")}; return Spaces;`)(class {}, trackedExec);
    const view = new Spaces();
    Object.assign(view, { checked: {}, unsure: new Set(), git: {}, watch() {} });
    const key = JSON.stringify([null, root]);
    await view.check(key, {});
    expect(view.git[key]).toMatchObject({ branch, ahead: 1, behind: 1 });
    expect(view.unsure.has(key)).toBe(false);
    expect(calls.some(args => args.includes("status"))).toBe(false);
    expect(git("checkout", "--detach", "-q").code).toBe(0);
    await view.check(key, {});
    expect(view.git[key]?.branch).toBe("(detached)");
    expect(git("checkout", "-q", branch).code).toBe(0);
    const tasks: Promise<void>[] = [];
    let action = "open";
    const writes: any[] = [];
    const globals = {
      View: class {}, exec: trackedExec, props: () => ({ action, folder: root }),
      spaces: () => [], panes: () => [], home: () => root,
      InputState: { new: () => ({ on() {}, focus() {} }) },
      run: (...args: any[]) => writes.push(args), closeOverlay() {},
    };
    const Worktree = new Function(...Object.keys(globals), `${sources.get("worktree")}; return Worktree;`)(...Object.values(globals));
    const cx = { notify() {}, timer: { after() {} }, focus_handle: () => ({ focus() {} }), spawn(fn: Function) { tasks.push(fn(cx)); } };
    const open = new Worktree(); open.init({}, cx); await Promise.all(tasks.splice(0));
    expect(open.repo?.top).toBe(root);
    expect(open.list).toHaveLength(1);
    open.open(open.list[0]);
    expect(writes.at(-1)?.[0]).toBe("space.new");
    action = "new";
    const create = new Worktree(); create.init({}, cx); await Promise.all(tasks.splice(0));
    expect(create.repo?.top).toBe(root);
    create.text = "new-filter-branch";
    expect(await create.create()).toBe("");
    expect(git("show-ref", "--verify", "refs/heads/new-filter-branch").code).toBe(0);
    const remove = new Worktree();
    Object.assign(remove, { repo: open.repo, on: null });
    expect(await remove.remove()).toContain("from a terminal");
    action = "remove";
    const dialog = new Worktree(); dialog.init({}, cx); await Promise.all(tasks.splice(0));
    expect(dialog.error).toContain("from a terminal");
    expect(calls.some(args => args.includes("status"))).toBe(false);
    for (const name of ["files", "changes"]) await expect(load(name, trackedExec)(root, null)).rejects.toThrow();
    const { view: changes, refresh } = changesView(root, trackedExec);
    await refresh();
    expect(changes.error).toBeTruthy();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

async function fixture(run: (root: string, git: (...args: string[]) => any, exec: Function) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-command-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "global") };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root, env });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const exec = async (_command: string, args: string[], options: { cwd?: string }) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: options.cwd ?? root, env });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  try {
    expect(git("init", "-q").code).toBe(0);
    await writeFile(join(root, "tracked"), "before\n");
    expect(git("add", ".").code).toBe(0);
    expect(git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture").code).toBe(0);
    await run(root, git, exec);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function changesView(root: string, exec: Function) {
  const Changes = new Function("View", "exec", "spaces", "panes", "focused",
    `${sources.get("changes")}; return Changes;`)(class {}, exec,
    () => [{ active: true, folder: root }], () => [], () => null);
  const view = new Changes();
  view.input = { set_value() {} };
  view.watch = () => {};
  const tasks: Promise<void>[] = [];
  const cx = { notify() {}, spawn(fn: Function) { tasks.push(fn(cx)); } };
  return { view, refresh: async () => { view.refresh(cx); await Promise.all(tasks.splice(0)); } };
}

test("Changes refresh cannot override the lazy-fetch barrier with protocol.file.allow", async () => {
  await fixture(async (root, git, exec) => {
    const marker = join(root, "EXECUTED");
    const blob = git("rev-parse", "HEAD:tracked").stdout.trim();
    await writeFile(join(root, "tracked"), "after\n");
    for (const [key, value] of [
      ["remote.origin.url", root], ["remote.origin.promisor", "true"],
      ["remote.origin.uploadpack", `touch '${marker}'; false`], ["protocol.file.allow", "always"],
    ]) expect(git("config", key, value).code).toBe(0);
    await rm(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    git("diff", "HEAD", "--numstat");
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    const { refresh } = changesView(root, exec);
    await refresh();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("Worktree checkout dates cannot lazy-fetch a missing commit", async () => {
  await fixture(async (root, git, exec) => {
    const marker = join(root, "EXECUTED");
    const commit = git("rev-parse", "HEAD").stdout.trim();
    for (const [key, value] of [
      ["remote.origin.url", root], ["remote.origin.promisor", "true"],
      ["remote.origin.uploadpack", `touch '${marker}'; false`],
    ]) expect(git("config", key, value).code).toBe(0);
    await rm(join(root, ".git/objects", commit.slice(0, 2), commit.slice(2)));
    git("for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads");
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    const checkouts = new Function("View", "exec", `${sources.get("worktree")}; return checkouts;`)(class {}, exec);
    if (git("--no-lazy-fetch", "version").code === 0) {
      const list = await checkouts({ main: root }, null);
      expect(list).toHaveLength(1);
    } else await expect(checkouts({ main: root }, null)).rejects.toThrow();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("Changes keeps moved gitlinks visible without running nested external diff or textconv", async () => {
  await fixture(async (root, git, exec) => {
    const marker = join(root, "EXECUTED");
    expect(git("init", "-q", "child").code).toBe(0);
    await writeFile(join(root, "child/tracked"), "first\n");
    const child = (...args: string[]) => git("-C", join(root, "child"), ...args);
    const commit = () => child("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "child");
    expect(child("add", ".").code).toBe(0);
    expect(commit().code).toBe(0);
    expect(git("-c", "protocol.file.allow=always", "submodule", "add", "./child", "child").code).toBe(0);
    expect(git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "submodule").code).toBe(0);
    await writeFile(join(root, "child/tracked"), "second\n");
    expect(commit().code).toBe(0);
    expect(git("config", "diff.submodule", "diff").code).toBe(0);
    expect(git("config", "status.submoduleSummary", "true").code).toBe(0);
    const { view, refresh } = changesView(root, exec);
    for (const driver of ["external", "textconv"]) {
      if (driver === "external") expect(child("config", "diff.external", `touch '${marker}'; true`).code).toBe(0);
      else {
        expect(child("config", "--unset", "diff.external").code).toBe(0);
        await writeFile(join(root, "child/.git/info/attributes"), "tracked diff=x\n");
        expect(child("config", "diff.x.textconv", `touch '${marker}'; cat`).code).toBe(0);
      }
      git("diff", "HEAD", "--ignore-submodules=dirty", "--no-ext-diff", "--no-textconv", "--", "child");
      expect(await Bun.file(marker).exists()).toBe(true);
      await rm(marker);
      await refresh();
      expect(view.error).toBeNull();
      expect(view.files.some((f: any) => f.path === "child")).toBe(true);
      expect(view.files.find((f: any) => f.path === "child").add).toBe(1);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(git("add", "child").code).toBe(0);
      await refresh();
      expect(view.files.some((f: any) => f.path === "child")).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
    }
  });
});

test("copied and included config cannot execute a clean filter during sidebar refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-safety-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "global") };
  const exec = async (command: string, args: string[], options: { cwd: string }) => {
    const p = Bun.spawn([command, ...args], { cwd: options.cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };
  const git = async (...args: string[]) => {
    const result = await exec("git", args, { cwd: root });
    expect(result.code).toBe(0);
    return result;
  };
  try {
    await git("init", "-q");
    await writeFile(join(root, ".gitattributes"), "* filter=x\n");
    await writeFile(join(root, "tracked"), "before\n");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
    await writeFile(join(root, "tracked"), "after, different size\n");
    const Spaces = new Function("View", "exec", `${sources.get("spaces")}; return Spaces;`)(class {}, exec);
    const view = new Spaces();
    view.checked = {}; view.unsure = new Set(); view.git = {}; view.watch = () => {};
    const key = JSON.stringify([null, root]);
    await view.check(key, {});
    expect(view.git[key]?.branch).toBeTruthy();
    const marker = join(root, "EXECUTED").replaceAll("\\", "/");
    await git("-c", "protocol.file.allow=always", "submodule", "add", "-q", root, "child");
    await writeFile(join(root, "child", "tracked"), "dirty child\n");
    await load("worktree", exec)(root, null, true);
    const dirty = await git("--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain");
    expect(dirty.stdout).toContain("child");
    await git("-C", join(root, "child"), "config", "filter.x.clean", "echo unsafe");
    await expect(load("worktree", exec)(root, null, true)).rejects.toThrow();
    await git("config", "filter.x.clean", `echo executed > '${marker.replaceAll("'", "'\\''")}'; cat`);
    for (const name of mods) await expect(load(name, exec)(root, null)).rejects.toThrow();
    await view.check(key, {});
    expect(await Bun.file(marker).exists()).toBe(false);
    // Included config inherits the repository's scope, not the user's trust.
    await git("config", "--unset", "filter.x.clean");
    const included = join(root, "included");
    await writeFile(included, "[filter \"x\"]\nclean = echo bad\n");
    await git("config", "include.path", included);
    for (const name of mods) await expect(load(name, exec)(root, null)).rejects.toThrow();
    await git("config", "--unset", "include.path");
    await git("config", "extensions.worktreeConfig", "true");
    await git("config", "--worktree", "filter.x.clean", "echo bad");
    for (const name of mods) await expect(load(name, exec)(root, null)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
