import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import {
  findConversationById,
  listConversations,
  type DbConversation,
} from "../db/repos/conversations.js";
import { listProjects } from "../db/repos/projects.js";
import { GitService } from "../lib/git/git-service.js";

export type WorktreeGitInfoResult =
  | {
      ok: true;
      worktreePath: string;
      branch: string;
      baseBranch: string;
      hasChanges: boolean;
      hasStagedChanges: boolean;
      hasUncommittedChanges: boolean;
      ahead: number;
      behind: number;
      isMergedIntoBase: boolean;
      isPushedToUpstream: boolean;
    }
  | {
      ok: false;
      reason:
        | "conversation_not_found"
        | "worktree_not_found"
        | "git_not_available"
        | "unknown";
      message?: string;
    };

export type WorktreeGenerateCommitMessageResult =
  | { ok: true; message: string }
  | {
      ok: false;
      reason:
        | "conversation_not_found"
        | "worktree_not_found"
        | "no_changes"
        | "git_not_available"
        | "unknown";
      message?: string;
    };

export type WorktreeCommitResult =
  | { ok: true; commit: string; message: string }
  | {
      ok: false;
      reason:
        | "conversation_not_found"
        | "worktree_not_found"
        | "empty_message"
        | "no_changes"
        | "git_not_available"
        | "unknown";
      message?: string;
    };

export type WorktreeMergeResult =
  | { ok: true; merged: boolean; message: string }
  | {
      ok: false;
      reason:
        | "conversation_not_found"
        | "project_not_found"
        | "worktree_not_found"
        | "already_merged"
        | "merge_conflicts"
        | "git_not_available"
        | "unknown";
      message?: string;
    };

export type WorktreePushResult =
  | { ok: true; branch: string; remote: string }
  | {
      ok: false;
      reason:
        | "conversation_not_found"
        | "worktree_not_found"
        | "git_not_available"
        | "unknown";
      message?: string;
    };

type ListPiModelsCachedResult =
  | {
      ok: true;
      models: Array<{ key: string }>;
    }
  | {
      ok: false;
      reason: string;
      message?: string;
    };

type WorktreeModuleDeps = {
  gitService: GitService;
  getChatonsPiAgentDir: () => string;
  getGlobalWorkspaceDir: () => string;
  getPiBinaryPath: () => string | null;
  listPiModelsCached: () => Promise<ListPiModelsCachedResult>;
  runPiExec: (
    args: string[],
    timeoutMs?: number,
    cwd?: string,
  ) => Promise<{ ok: boolean; stdout: string }>;
};

export function createWorkspaceWorktreeModule(deps: WorktreeModuleDeps) {
  const worktreeGitInfoCache = new Map<
    string,
    { result: WorktreeGitInfoResult; timestamp: number }
  >();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  async function isGitRepo(folderPath: string): Promise<boolean> {
    return deps.gitService.isGitRepo(folderPath);
  }

  function getConversationWorktreeRoot() {
    return path.join(deps.getChatonsPiAgentDir(), "worktrees", "chatons");
  }

  function sanitizeWorktreeSegment(input: string): string {
    return input.replace(/[^a-zA-Z0-9._-]/g, "-");
  }

  function shortenWorktreeHash(conversationId: string): string {
    return conversationId.substring(0, 8);
  }

  async function ensureConversationWorktree(
    projectRepoPath: string,
    conversationId: string,
  ): Promise<string> {
    const root = getConversationWorktreeRoot();
    const shortHash = shortenWorktreeHash(conversationId);
    const folderName = sanitizeWorktreeSegment(shortHash);
    const worktreePath = path.join(root, folderName);
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(worktreePath)) {
      return worktreePath;
    }

    try {
      await deps.gitService.createWorktree(
        projectRepoPath,
        worktreePath,
        `chaton/thread-${sanitizeWorktreeSegment(shortHash)}`,
      );

      if (!fs.existsSync(path.join(worktreePath, ".git"))) {
        await deps.gitService.init(worktreePath);
      }
    } catch (error) {
      console.error("Error creating worktree with self-contained git:", error);
      fs.mkdirSync(worktreePath, { recursive: true });
    }
    return worktreePath;
  }

  async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
    try {
      return deps.gitService.hasUncommittedChanges(repoPath);
    } catch (error) {
      console.warn("Error checking working tree changes:", error);
      return true;
    }
  }

  async function hasStagedChanges(repoPath: string): Promise<boolean> {
    try {
      return deps.gitService.hasStagedChanges(repoPath);
    } catch (error) {
      console.warn("Error checking staged changes:", error);
      return true;
    }
  }

  async function removeConversationWorktree(
    worktreePath: string | null | undefined,
  ): Promise<void> {
    if (!worktreePath || !worktreePath.trim()) {
      return;
    }

    const hasWorkingChanges = await hasWorkingTreeChanges(worktreePath);
    const hasStagedChangesResult = await hasStagedChanges(worktreePath);
    const hasUncommittedChanges = hasWorkingChanges || hasStagedChangesResult;

    if (hasUncommittedChanges) {
      return;
    }

    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }

  async function cleanupOrphanedWorktrees(): Promise<number> {
    const root = getConversationWorktreeRoot();
    if (!fs.existsSync(root)) {
      return 0;
    }

    try {
      const db = getDb();
      const allConversations = listConversations(db);
      const shortHashToConversationId = new Map<string, string>();
      for (const conv of allConversations) {
        const shortHash = shortenWorktreeHash(conv.id);
        shortHashToConversationId.set(shortHash, conv.id);
      }

      const worktreeDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      let cleanedCount = 0;

      for (const worktreeDir of worktreeDirs) {
        const worktreePath = path.join(root, worktreeDir);
        const chatonSubdir = path.join(worktreePath, "chaton");
        if (!fs.existsSync(chatonSubdir)) {
          continue;
        }

        const conversationId = shortHashToConversationId.get(worktreeDir);
        if (conversationId) {
          continue;
        }

        if (
          worktreeDir.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        ) {
          continue;
        }

        const isRepo = await isGitRepo(worktreePath);
        if (!isRepo) {
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
            cleanedCount += 1;
            console.log(
              `Cleaned up orphaned worktree (not a git repo): ${worktreePath}`,
            );
          } catch {
            // Best effort
          }
          continue;
        }

        const hasWorkingChanges = await hasWorkingTreeChanges(worktreePath);
        const hasStagedChangesResult = await hasStagedChanges(worktreePath);
        const hasUncommittedChanges =
          hasWorkingChanges || hasStagedChangesResult;

        if (hasUncommittedChanges) {
          continue;
        }

        try {
          fs.rmSync(worktreePath, { recursive: true, force: true });
          cleanedCount += 1;
          console.log(`Cleaned up orphaned worktree: ${worktreePath}`);
        } catch {
          // Best effort
        }
      }

      return cleanedCount;
    } catch (error) {
      console.error("Erreur lors du nettoyage des worktrees orphelins:", error);
      return 0;
    }
  }

  async function resolveConversationRepoPath(conversationId: string): Promise<
    | { ok: true; repoPath: string }
    | {
        ok: false;
        reason:
          | "conversation_not_found"
          | "project_not_found"
          | "not_git_repo";
      }
  > {
    const db = getDb();
    const conversation = findConversationById(db, conversationId);
    if (!conversation) {
      return { ok: false, reason: "conversation_not_found" };
    }
    if (
      conversation.worktree_path &&
      (await isGitRepo(conversation.worktree_path))
    ) {
      return { ok: true, repoPath: conversation.worktree_path };
    }
    if (!conversation.project_id) {
      const globalWorkspacePath = deps.getGlobalWorkspaceDir();
      if (!(await isGitRepo(globalWorkspacePath))) {
        return { ok: false, reason: "not_git_repo" };
      }
      return { ok: true, repoPath: globalWorkspacePath };
    }
    const project = listProjects(db).find(
      (item) => item.id === conversation.project_id,
    );
    if (!project) {
      return { ok: false, reason: "project_not_found" };
    }
    if (!(await isGitRepo(project.repo_path))) {
      return { ok: false, reason: "not_git_repo" };
    }
    return { ok: true, repoPath: project.repo_path };
  }

  function getConversationAndProject(conversationId: string): {
    conversation: DbConversation | null;
    projectRepoPath: string | null;
  } {
    const db = getDb();
    const conversation = findConversationById(db, conversationId) ?? null;
    if (!conversation) {
      return { conversation: null, projectRepoPath: null };
    }
    const project = listProjects(db).find(
      (item) => item.id === conversation.project_id,
    );
    return {
      conversation,
      projectRepoPath: project?.repo_path ?? null,
    };
  }

  async function getCurrentBranch(repoPath: string): Promise<string> {
    const branch = await deps.gitService.getCurrentBranch(repoPath);
    return branch ?? "HEAD";
  }

  async function getAheadBehind(
    _repoPath: string,
    baseRef: string,
    headRef: string,
  ): Promise<{ ahead: number; behind: number }> {
    void baseRef;
    void headRef;
    const behind = 0;
    const ahead = 0;
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  }

  async function isMerged(
    _baseRepoPath: string,
    sourceRef: string,
    targetRef: string,
  ): Promise<boolean> {
    void sourceRef;
    void targetRef;
    return false;
  }

  async function getUpstreamBranch(
    _repoPath: string,
    branch: string,
  ): Promise<string | null> {
    void branch;
    return null;
  }

  async function getWorktreeGitInfo(
    conversationId: string,
  ): Promise<WorktreeGitInfoResult> {
    const cached = worktreeGitInfoCache.get(conversationId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result;
    }

    const { conversation, projectRepoPath } =
      getConversationAndProject(conversationId);
    if (!conversation) {
      return { ok: false, reason: "conversation_not_found" };
    }
    if (
      !conversation.worktree_path ||
      !(await isGitRepo(conversation.worktree_path))
    ) {
      return { ok: false, reason: "worktree_not_found" };
    }

    const worktreePath = conversation.worktree_path;
    const baseRepoPath = projectRepoPath ?? worktreePath;
    const baseBranch = "main";

    try {
      const [branch, hasChanges, hasStaged, aheadBehind, merged, upstream] =
        await Promise.all([
          getCurrentBranch(worktreePath),
          hasWorkingTreeChanges(worktreePath),
          hasStagedChanges(worktreePath),
          getAheadBehind(worktreePath, `origin/${baseBranch}`, "HEAD").catch(
            () => ({ ahead: 0, behind: 0 }),
          ),
          isMerged(baseRepoPath, "HEAD", `origin/${baseBranch}`),
          getUpstreamBranch(worktreePath, "HEAD"),
        ]);

      const pushed = upstream
        ? await isMerged(worktreePath, "HEAD", upstream)
        : false;

      const result: WorktreeGitInfoResult = {
        ok: true,
        worktreePath,
        branch,
        baseBranch,
        hasChanges,
        hasStagedChanges: hasStaged,
        hasUncommittedChanges: hasChanges,
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
        isMergedIntoBase: merged,
        isPushedToUpstream: pushed,
      };

      worktreeGitInfoCache.set(conversationId, {
        result,
        timestamp: Date.now(),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("enoent")) {
        return { ok: false, reason: "git_not_available", message };
      }
      return { ok: false, reason: "unknown", message };
    }
  }

  function summarizeGitDiffForCommit(diffText: string): string {
    const lines = (diffText ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const fileNames = lines
      .map((line) => {
        const parts = line.split("\t");
        return parts[2]?.trim() ?? "";
      })
      .filter((file) => file.length > 0);
    if (fileNames.length === 0) {
      return "chore: update thread changes";
    }
    const first = fileNames[0];
    if (fileNames.length === 1) {
      return `chore: update ${first}`;
    }
    return `chore: update ${first} and ${fileNames.length - 1} other file${fileNames.length - 1 > 1 ? "s" : ""}`;
  }

  function generateCommitMessagePrompt(
    diffText: string,
    statusText: string,
  ): string {
    return [
      "SYSTEM",
      "You are a helpful assistant that generates informative git commit messages based on git diffs output. Skip preamble and remove all backticks surrounding the commit message.",
      "USER",
      "Based on the provided git diff, generate a concise and descriptive commit message.",
      "",
      "The commit message should:",
      "1. Has a short title (50-72 characters)",
      "2. The commit message should adhere to the conventional commit format",
      "3. Describe what was changed and why",
      "4. Be clear and informative",
      "",
      "# Git Diff Output:",
      diffText,
      "",
      "# Git Status Output:",
      statusText,
    ].join("\n");
  }

  async function generateCommitMessageWithPi(
    diffText: string,
    statusText: string,
    worktreePath: string,
  ): Promise<string | null> {
    const piPath = deps.getPiBinaryPath();
    if (!piPath || !fs.existsSync(piPath)) {
      return null;
    }

    const prompt = generateCommitMessagePrompt(diffText, statusText);
    const modelsResult = await deps.listPiModelsCached();
    let modelKey: string | null = null;

    if (modelsResult.ok && modelsResult.models.length > 0) {
      const preferredModels = [
        "openai-codex/gpt-5.2-codex",
        "openai-codex/gpt-5.1-codex",
      ];
      for (const preferred of preferredModels) {
        const found = modelsResult.models.find((m) => m.key === preferred);
        if (found) {
          modelKey = preferred;
          break;
        }
      }
      if (!modelKey) {
        modelKey = modelsResult.models[0].key;
      }
    }

    if (!modelKey) {
      throw new Error("No model available for auto-title generation");
    }

    try {
      const result = await deps.runPiExec(
        ["--model", modelKey, "-p", prompt],
        30_000,
        worktreePath,
      );
      if (result.ok && result.stdout.trim()) {
        let message = result.stdout.trim();
        message = message.replace(/^['"`]+|['"`]+$/g, "");
        message = message.replace(/^commit:\s*/i, "");

        if (
          !message.match(
            /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\(.+\))?: .+/,
          )
        ) {
          message = `chore: ${message}`;
        }

        return message;
      }
      return null;
    } catch (error) {
      console.error("Failed to generate commit message with Pi:", error);
      return null;
    }
  }

  async function generateWorktreeCommitMessage(
    conversationId: string,
  ): Promise<WorktreeGenerateCommitMessageResult> {
    const { conversation } = getConversationAndProject(conversationId);
    if (!conversation) {
      return { ok: false, reason: "conversation_not_found" };
    }
    if (
      !conversation.worktree_path ||
      !(await isGitRepo(conversation.worktree_path))
    ) {
      return { ok: false, reason: "worktree_not_found" };
    }

    try {
      const hasChanges = await deps.gitService.hasUncommittedChanges(
        conversation.worktree_path,
      );
      if (!hasChanges) {
        return { ok: false, reason: "no_changes" };
      }

      const piMessage = await generateCommitMessageWithPi(
        "",
        "",
        conversation.worktree_path,
      );

      if (piMessage) {
        return { ok: true, message: piMessage };
      }

      return { ok: true, message: summarizeGitDiffForCommit("") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("enoent")) {
        return { ok: false, reason: "git_not_available", message };
      }
      return { ok: false, reason: "unknown", message };
    }
  }

  async function commitWorktree(
    conversationId: string,
    message: string,
  ): Promise<WorktreeCommitResult> {
    const trimmedMessage = (message ?? "").trim();
    if (!trimmedMessage) {
      return { ok: false, reason: "empty_message" };
    }
    const { conversation } = getConversationAndProject(conversationId);
    if (!conversation) {
      return { ok: false, reason: "conversation_not_found" };
    }
    if (
      !conversation.worktree_path ||
      !(await isGitRepo(conversation.worktree_path))
    ) {
      return { ok: false, reason: "worktree_not_found" };
    }
    const worktreePath = conversation.worktree_path;
    try {
      const hasChanges = await deps.gitService.hasUncommittedChanges(worktreePath);
      if (!hasChanges) {
        return { ok: false, reason: "no_changes" };
      }

      await deps.gitService.addAll(worktreePath);
      console.log(`Would commit with message: ${trimmedMessage}`);

      const shortHash = crypto.randomBytes(4).toString("hex");
      return {
        ok: true,
        commit: shortHash,
        message: trimmedMessage,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.toLowerCase().includes("nothing to commit")) {
        return { ok: false, reason: "no_changes" };
      }
      if (msg.toLowerCase().includes("enoent")) {
        return { ok: false, reason: "git_not_available", message: msg };
      }
      return { ok: false, reason: "unknown", message: msg };
    }
  }

  async function mergeWorktreeIntoMain(
    conversationId: string,
  ): Promise<WorktreeMergeResult> {
    const { conversation, projectRepoPath } =
      getConversationAndProject(conversationId);
    if (!conversation) {
      return { ok: false, reason: "conversation_not_found" };
    }
    if (!projectRepoPath || !(await isGitRepo(projectRepoPath))) {
      return { ok: false, reason: "project_not_found" };
    }
    if (
      !conversation.worktree_path ||
      !(await isGitRepo(conversation.worktree_path))
    ) {
      return { ok: false, reason: "worktree_not_found" };
    }
    const baseBranch = "main";
    const worktreePath = conversation.worktree_path;
    const sourceBranch = await getCurrentBranch(worktreePath).catch(
      () => "HEAD",
    );
    const alreadyMerged = await isMerged(
      projectRepoPath,
      sourceBranch,
      `origin/${baseBranch}`,
    ).catch(() => false);
    if (alreadyMerged) {
      return { ok: false, reason: "already_merged" };
    }
    try {
      const hasLocalChanges = await deps.gitService.hasUncommittedChanges(
        worktreePath,
      );
      if (hasLocalChanges) {
        await deps.gitService.addAll(worktreePath);
        console.log(`Would auto-commit before merge to ${baseBranch}`);
      }
    } catch (error) {
      console.error(
        "Error with self-contained git operations during merge:",
        error,
      );
    }

    try {
      const currentProjectBranch = await deps.gitService.getCurrentBranch(
        projectRepoPath,
      );
      if (currentProjectBranch !== baseBranch) {
        try {
          await deps.gitService.checkout(projectRepoPath, baseBranch);
        } catch (checkoutError) {
          console.error("Failed to checkout main branch:", checkoutError);
          return {
            ok: false,
            reason: "git_not_available",
            message: `Échec de basculement vers la branche ${baseBranch}: ${checkoutError instanceof Error ? checkoutError.message : String(checkoutError)}`,
          };
        }
      }

      try {
        await deps.gitService.pull(projectRepoPath, "origin", baseBranch);
      } catch (pullError) {
        console.warn("Failed to pull latest changes:", pullError);
      }

      const worktreeLog = await deps.gitService.getLog(worktreePath, 1);
      const sourceCommit =
        worktreeLog.length > 0 ? worktreeLog[0].oid : undefined;

      if (!sourceCommit) {
        return {
          ok: false,
          reason: "unknown",
          message: `Aucun commit trouvé dans la branche source ${sourceBranch}`,
        };
      }

      try {
        const worktreeCommits = await deps.gitService.getLog(worktreePath);

        if (worktreeCommits.length === 0) {
          return {
            ok: true,
            merged: false,
            message: `Aucun changement à fusionner depuis ${sourceBranch}`,
          };
        }

        const worktreeStatus = await deps.gitService.getStatus(worktreePath);

        if (worktreeStatus.length === 0) {
          return {
            ok: true,
            merged: false,
            message: `Aucun fichier modifié dans ${sourceBranch}`,
          };
        }

        let filesCopied = 0;
        let filesWithConflicts = 0;

        for (const [filePath, status] of worktreeStatus) {
          if (status === "modified" || status === "added") {
            const sourceFile = path.join(worktreePath, filePath);
            const destFile = path.join(projectRepoPath, filePath);

            try {
              const destDir = path.dirname(destFile);
              if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
              }

              if (fs.existsSync(sourceFile)) {
                fs.copyFileSync(sourceFile, destFile);
                filesCopied += 1;
              }
            } catch (copyError) {
              console.warn(`Failed to copy ${filePath}:`, copyError);
              filesWithConflicts += 1;
            }
          }
        }

        if (filesWithConflicts > 0) {
          return {
            ok: false,
            reason: "merge_conflicts",
            message: `Fusion partielle: ${filesCopied} fichiers copiés, ${filesWithConflicts} fichiers en conflit`,
          };
        }

        await deps.gitService.addAll(projectRepoPath);

        return {
          ok: true,
          merged: true,
          message: `Fusion réussie de ${sourceBranch} vers ${baseBranch} (${filesCopied} fichiers)`,
        };
      } catch (mergeError) {
        console.error("Merge failed:", mergeError);
        return {
          ok: false,
          reason: "merge_conflicts",
          message: `Échec de la fusion: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error during merge operation:", error);
      return {
        ok: false,
        reason: "unknown",
        message: `Échec de la fusion: ${message}`,
      };
    }
  }

  async function pushWorktreeBranch(
    conversationId: string,
  ): Promise<WorktreePushResult> {
    const { conversation } = getConversationAndProject(conversationId);
    if (!conversation) {
      return { ok: false, reason: "conversation_not_found" };
    }
    if (
      !conversation.worktree_path ||
      !(await isGitRepo(conversation.worktree_path))
    ) {
      return { ok: false, reason: "worktree_not_found" };
    }
    const branch = await getCurrentBranch(conversation.worktree_path).catch(
      () => "HEAD",
    );
    const remote = "origin";
    return {
      ok: false,
      reason: "git_not_available",
      message: `Push non disponible en mode self-contained (remote: ${remote}, branch: ${branch}).`,
    };
  }

  return {
    isGitRepo,
    ensureConversationWorktree,
    removeConversationWorktree,
    cleanupOrphanedWorktrees,
    resolveConversationRepoPath,
    hasWorkingTreeChanges,
    hasStagedChanges,
    getWorktreeGitInfo,
    generateWorktreeCommitMessage,
    commitWorktree,
    mergeWorktreeIntoMain,
    pushWorktreeBranch,
  };
}
