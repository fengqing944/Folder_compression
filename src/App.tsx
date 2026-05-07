import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Archive,
  Bell,
  CheckCircle2,
  FolderArchive,
  FolderOpen,
  KeyRound,
  Layers,
  Link2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import appLogoUrl from "./assets/app-logo.svg";
import "./App.css";

type ToolStatus = {
  winrarPath: string;
  winrarExists: boolean;
  sevenzPath: string;
  sevenzExists: boolean;
};

type FolderPreview = {
  path: string;
  name: string;
  parent: string;
  sizeBytes: number;
  sizeMb: number;
};

type PrefixRule = {
  keyword: string;
  prefix: string;
};

type PrefixPreview = {
  folderName: string;
  articleId: string;
  matchedKeyword: string | null;
  archivePrefix: string;
  archiveStem: string;
  rarFileName: string;
  sevenzFileName: string;
  confidence: number;
};

type CompressionReport = {
  sourcePath: string;
  outputDirectory: string;
  rarFiles: string[];
  sevenzFile: string | null;
  deletedRar: boolean;
  cleanedOutputs: string[];
  folderSizeBytes: number;
  folderSizeMb: number;
  usedSplitVolume: boolean;
  matchedKeyword: string | null;
  archivePrefix: string;
  archiveStem: string;
  steps: Array<{
    name: string;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
};

type TaskStatus = "idle" | "loading" | "ready" | "running" | "cancelling" | "success" | "cancelled" | "error";
type NotificationKind = "success" | "failure" | "cancelled";

type NotificationSettings = {
  enabled: boolean;
  success: boolean;
  failure: boolean;
  cancelled: boolean;
};

const defaultWinrarPath = "G:\\Software\\WinRAR\\WinRAR.exe";
const defaultSevenzPath = "C:\\Program Files\\7-Zip\\7z.exe";
const notificationSettingsStorageKey = "folder-compression.notification-settings.v1";

function App() {
  const folderRequestId = useRef(0);
  const taskLockedRef = useRef(false);
  const [activeTab, setActiveTab] = useState<"task" | "prefix" | "settings">("task");
  const [sourcePath, setSourcePath] = useState("");
  const [articleId, setArticleId] = useState("");
  const [winrarPath, setWinrarPath] = useState(defaultWinrarPath);
  const [sevenzPath, setSevenzPath] = useState(defaultSevenzPath);
  const [secondCompression, setSecondCompression] = useState(false);
  const [deleteRar, setDeleteRar] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [splitVolume, setSplitVolume] = useState(true);
  const [createFolder, setCreateFolder] = useState(true);
  const [forceCreateFolder, setForceCreateFolder] = useState(false);
  const [volumeSize, setVolumeSize] = useState("500m");
  const [rarPassword, setRarPassword] = useState("moeuu.xyz");
  const [encryptFileNames, setEncryptFileNames] = useState(true);
  const [syncSevenzPassword, setSyncSevenzPassword] = useState(true);
  const [sevenzPassword, setSevenzPassword] = useState("moeuu.xyz");
  const [dragActive, setDragActive] = useState(false);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<FolderPreview | null>(null);
  const [prefixPreview, setPrefixPreview] = useState<PrefixPreview | null>(null);
  const [prefixRules, setPrefixRules] = useState<PrefixRule[]>([]);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [rulePrefix, setRulePrefix] = useState("");
  const [ruleSearch, setRuleSearch] = useState("");
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [report, setReport] = useState<CompressionReport | null>(null);
  const [logs, setLogs] = useState<string[]>(["等待拖入文件夹。"]);
  const [taskStatus, setTaskStatus] = useState<TaskStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("等待拖入文件夹。");
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(
    loadNotificationSettings,
  );
  const [notificationBusy, setNotificationBusy] = useState(false);

  const outputHint = useMemo(() => {
    if (!preview || !articleId.trim()) return "填写文章 ID 后预览输出位置";
    const shouldCreate = createFolder || forceCreateFolder || (splitVolume && preview.sizeMb > 500);
    return shouldCreate ? `${preview.parent}\\${articleId.trim()}` : preview.parent;
  }, [articleId, createFolder, forceCreateFolder, preview, splitVolume]);

  const archiveNameHint = useMemo(() => {
    if (!preview) return "未选择";
    if (!articleId.trim()) return "填写文章 ID 后预览文件名";
    return prefixPreview?.rarFileName ?? "正在匹配";
  }, [articleId, prefixPreview, preview]);

  const volumeSizeError = useMemo(() => {
    if (!splitVolume) return "";
    return isValidVolumeSize(volumeSize)
      ? ""
      : "分卷大小格式不正确，请使用 500m、1g、102400k 这类格式";
  }, [splitVolume, volumeSize]);

  const filteredRules = useMemo(() => {
    const keyword = ruleSearch.trim().toLowerCase();
    if (!keyword) return prefixRules;
    return prefixRules.filter((rule) =>
      `${rule.keyword} ${rule.prefix}`.toLowerCase().includes(keyword),
    );
  }, [prefixRules, ruleSearch]);

  const effectiveSevenzPassword = syncSevenzPassword ? rarPassword : sevenzPassword;
  const taskLocked = running || taskStatus === "loading" || taskStatus === "cancelling";

  const compressionInputsSignature = useMemo(
    () =>
      JSON.stringify({
        sourcePath,
        articleId,
        winrarPath,
        sevenzPath,
        rarPassword,
        encryptFileNames,
        syncSevenzPassword,
        secondCompression,
        deleteRar,
        backgroundMode,
        splitVolume,
        createFolder,
        forceCreateFolder,
        volumeSize,
        effectiveSevenzPassword,
        prefixRules,
      }),
    [
      articleId,
      backgroundMode,
      createFolder,
      deleteRar,
      encryptFileNames,
      forceCreateFolder,
      prefixRules,
      rarPassword,
      secondCompression,
      effectiveSevenzPassword,
      sevenzPath,
      sourcePath,
      splitVolume,
      syncSevenzPassword,
      volumeSize,
      winrarPath,
    ],
  );

  const lastCompressionInputsSignature = useRef(compressionInputsSignature);

  const statusLabel = useMemo(() => {
    if (taskStatus === "idle") return "等待选择";
    if (taskStatus === "loading") return "检查中";
    if (taskStatus === "running") return "压缩中";
    if (taskStatus === "cancelling") return "正在取消";
    if (taskStatus === "cancelled") return "已取消";
    if (taskStatus === "success") return "已完成";
    if (taskStatus === "error") return "需要处理";
    return "就绪";
  }, [taskStatus]);

  const statusDetail = useMemo(() => {
    if (taskStatus === "loading" || taskStatus === "cancelling" || taskStatus === "cancelled" || taskStatus === "error") {
      return statusMessage;
    }

    if (taskStatus === "success" && report) {
      return report.archiveStem;
    }

    if (preview) {
      return archiveNameHint;
    }

    return statusMessage;
  }, [archiveNameHint, preview, report, statusMessage, taskStatus]);

  const statusDotClass = useMemo(() => {
    if (taskStatus === "loading" || taskStatus === "running" || taskStatus === "cancelling") {
      return "status-dot busy";
    }
    if (taskStatus === "cancelled") return "status-dot cancelled";
    if (taskStatus === "error") return "status-dot error";
    return "status-dot";
  }, [taskStatus]);

  useEffect(() => {
    taskLockedRef.current = taskLocked;
  }, [taskLocked]);

  useEffect(() => {
    refreshTools();
    loadPrefixRules();
  }, []);

  useEffect(() => {
    saveNotificationSettings(notificationSettings);
  }, [notificationSettings]);

  useEffect(() => {
    if (lastCompressionInputsSignature.current === compressionInputsSignature) return;
    lastCompressionInputsSignature.current = compressionInputsSignature;

    if (taskLocked) return;

    if (report) {
      setReport(null);
    }

    if (taskStatus === "success" || taskStatus === "cancelled" || taskStatus === "error") {
      setTaskStatus(preview ? "ready" : "idle");
    }
  }, [compressionInputsSignature, preview, report, taskLocked, taskStatus]);

  useEffect(() => {
    if (!secondCompression) {
      setDeleteRar(false);
    }
  }, [secondCompression]);

  useEffect(() => {
    const webview = getCurrentWebview();
    let cleanup: (() => void) | undefined;

    webview
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragActive(true);
          return;
        }

        if (event.payload.type === "leave") {
          setDragActive(false);
          return;
        }

        if (event.payload.type === "drop") {
          setDragActive(false);
          if (taskLockedRef.current) return;

          const [firstPath] = event.payload.paths;
          if (firstPath) {
            loadFolder(firstPath);
          }
        }
      })
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch((error) => appendLog(`拖拽监听启动失败：${String(error)}`));

    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!preview) {
      setPrefixPreview(null);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const nextPreview = await invoke<PrefixPreview>("preview_prefix", {
          folderName: preview.name,
          articleId,
          rules: prefixRules,
        });

        if (!cancelled) {
          setPrefixPreview(nextPreview);
        }
      } catch {
        if (!cancelled) {
          setPrefixPreview(null);
        }
      }
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [articleId, prefixRules, preview]);

  async function refreshTools() {
    try {
      const resolved = await invoke<ToolStatus>("resolve_tools", {
        winrarPath,
        sevenzPath,
      });
      setTools(resolved);
      setWinrarPath(resolved.winrarPath);
      setSevenzPath(resolved.sevenzPath);
    } catch (error) {
      appendLog(`工具路径检查失败：${String(error)}`);
    }
  }

  async function loadPrefixRules() {
    try {
      const rules = await invoke<PrefixRule[]>("load_prefix_rules");
      setPrefixRules(rules);
      appendLog(`已加载前缀规则：${rules.length} 条。`);
    } catch (error) {
      appendLog(`加载前缀规则失败：${String(error)}`);
    }
  }

  async function persistPrefixRules(nextRules: PrefixRule[], message: string) {
    try {
      const saved = await invoke<PrefixRule[]>("save_prefix_rules", { rules: nextRules });
      setPrefixRules(saved);
      appendLog(message);
    } catch (error) {
      appendLog(`保存前缀规则失败：${String(error)}`);
    }
  }

  async function addPrefixRule() {
    if (taskLocked) return;

    const keyword = ruleKeyword.trim();
    const prefix = sanitizePrefixInput(rulePrefix);

    if (!keyword || !prefix) {
      appendLog("关键词和前缀都要填写。");
      return;
    }

    const nextRules = [
      { keyword, prefix },
      ...prefixRules.filter((rule) => rule.keyword.toLowerCase() !== keyword.toLowerCase()),
    ];

    await persistPrefixRules(nextRules, `已保存前缀规则：${keyword} -> ${prefix}`);
    setRuleKeyword("");
    setRulePrefix("");
  }

  async function deletePrefixRule(keyword: string) {
    if (taskLocked) return;

    const nextRules = prefixRules.filter(
      (rule) => rule.keyword.toLowerCase() !== keyword.toLowerCase(),
    );
    await persistPrefixRules(nextRules, `已删除前缀规则：${keyword}`);
  }

  async function importPrefixRules() {
    if (taskLocked) return;

    const selected = await open({
      multiple: false,
      title: "导入前缀规则",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (typeof selected !== "string") return;

    try {
      const imported = await invoke<PrefixRule[]>("import_prefix_rules", {
        path: selected,
        merge: true,
      });
      setPrefixRules(imported);
      appendLog(`已导入前缀规则：${imported.length} 条。`);
    } catch (error) {
      appendLog(`导入前缀规则失败：${String(error)}`);
    }
  }

  async function chooseFolder() {
    if (taskLocked) return;

    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择要压缩的文件夹",
    });

    if (typeof selected === "string") {
      loadFolder(selected);
    }
  }

  async function loadFolder(path: string, announce = true) {
    const requestId = folderRequestId.current + 1;
    folderRequestId.current = requestId;
    setSourcePath(path);
    setPreview(null);
    setPrefixPreview(null);
    setReport(null);
    setTaskStatus("loading");
    setStatusMessage(`正在检查：${path}`);

    try {
      const nextPreview = await invoke<FolderPreview>("inspect_folder", { path });
      if (requestId !== folderRequestId.current) return;

      setPreview(nextPreview);
      setTaskStatus("ready");
      setStatusMessage(`已选择：${nextPreview.name}`);
      if (announce) {
        appendLog(`已选择：${nextPreview.name}（${formatSize(nextPreview.sizeBytes)}）`);
      }
    } catch (error) {
      if (requestId !== folderRequestId.current) return;

      setSourcePath("");
      setPreview(null);
      setPrefixPreview(null);
      setTaskStatus("error");
      setStatusMessage(`选择失败：${String(error)}`);
      if (announce) {
        appendLog(`选择失败：${String(error)}`);
      }
    }
  }

  async function startCompression() {
    if (running) return;
    setReport(null);

    if (!sourcePath.trim()) {
      const message = "请先拖入或选择一个文件夹。";
      setTaskStatus("error");
      setStatusMessage(message);
      appendLog(message);
      return;
    }

    if (!articleId.trim()) {
      const message = "文章 ID 必填。";
      setTaskStatus("error");
      setStatusMessage(message);
      appendLog(message);
      return;
    }

    if (secondCompression && syncSevenzPassword && !rarPassword.trim()) {
      const message = "7z 跟随 RAR 密码时，RAR 密码不能为空。";
      setTaskStatus("error");
      setStatusMessage(message);
      appendLog(message);
      return;
    }

    if (volumeSizeError) {
      setTaskStatus("error");
      setStatusMessage(volumeSizeError);
      appendLog(volumeSizeError);
      return;
    }

    setRunning(true);
    setTaskStatus("running");
    setStatusMessage(archiveNameHint);
    appendLog("开始压缩任务。");

    try {
      const result = await invoke<CompressionReport>("compress_folder", {
        options: {
          sourcePath,
          articleId,
          winrarPath,
          sevenzPath,
          rarPassword,
          encryptFileNames,
          secondCompression,
          deleteRar,
          backgroundMode,
          splitVolume,
          createFolder,
          forceCreateFolder,
          volumeSize,
          sevenzPassword: effectiveSevenzPassword,
          prefixRules,
        },
      });

      setReport(result);
      setTaskStatus("success");
      setStatusMessage(result.archiveStem);
      appendLog(`压缩完成：${result.outputDirectory}`);
      appendLog(`压缩包名称：${result.archiveStem}`);
      if (result.cleanedOutputs.length > 0) {
        appendLog(`已清理旧输出文件：${result.cleanedOutputs.length} 个。`);
      }
      if (result.matchedKeyword) {
        appendLog(`命中前缀规则：${result.matchedKeyword} -> ${result.archivePrefix}`);
      }
      if (result.usedSplitVolume) {
        appendLog("已启用 500MB 分卷。");
      }
      if (result.sevenzFile) {
        appendLog(`二次压缩完成：${result.sevenzFile}`);
      }
      if (result.deletedRar) {
        appendLog("已删除中间 RAR 文件。");
      }
      void sendSystemNotification("success", "压缩完成", `${result.archiveStem} 已生成。`);
    } catch (error) {
      const message = String(error);
      const cancelled = message.includes("压缩已取消");
      setTaskStatus(cancelled ? "cancelled" : "error");
      setStatusMessage(message);
      appendLog(cancelled ? message : `压缩失败：${message}`);
      void sendSystemNotification(
        cancelled ? "cancelled" : "failure",
        cancelled ? "压缩已取消" : "压缩失败",
        cancelled ? message : "查看任务日志获取详情。",
      );
    } finally {
      setRunning(false);
    }
  }

  async function cancelCompression() {
    if (!running || taskStatus === "cancelling") return;

    setTaskStatus("cancelling");
    setStatusMessage("正在取消压缩任务...");
    appendLog("正在取消压缩任务。");

    try {
      await invoke("cancel_compression");
    } catch (error) {
      if (String(error).includes("当前没有正在运行")) {
        appendLog("取消请求已忽略：任务已经结束。");
        return;
      }

      const message = `取消压缩请求失败：${String(error)}`;
      appendLog(message);
      setTaskStatus("error");
      setStatusMessage(message);
    }
  }

  function resetTask() {
    folderRequestId.current += 1;
    setSourcePath("");
    setPreview(null);
    setPrefixPreview(null);
    setReport(null);
    setTaskStatus("idle");
    setStatusMessage("等待拖入文件夹。");
    setLogs(["等待拖入文件夹。"]);
  }

  function appendLog(message: string) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs((current) => [`${time}  ${message}`, ...current].slice(0, 80));
  }

  async function sendSystemNotification(kind: NotificationKind, title: string, body: string) {
    if (!shouldSendNotification(notificationSettings, kind)) return;

    try {
      await invoke("send_task_notification", { title, body });
    } catch (error) {
      appendLog(`系统通知发送失败：${String(error)}`);
    }
  }

  async function testNotification() {
    if (!notificationSettings.enabled) {
      appendLog("任务通知已关闭，未发送测试通知。");
      return;
    }

    setNotificationBusy(true);
    try {
      await invoke("send_task_notification", {
        title: "文件夹压缩工具",
        body: "任务通知可以正常发送。",
      });
      appendLog("已发送测试通知。");
    } catch (error) {
      appendLog(`系统通知发送失败：${String(error)}`);
    } finally {
      setNotificationBusy(false);
    }
  }

  function updateNotificationSetting(key: keyof NotificationSettings, checked: boolean) {
    setNotificationSettings((current) => ({ ...current, [key]: checked }));
  }

  async function openResultLocation() {
    if (!report) return;

    const target = report.sevenzFile ?? report.rarFiles[0] ?? report.outputDirectory;
    try {
      await revealItemInDir(target);
    } catch (error) {
      appendLog(`打开结果失败：${String(error)}`);
      setTaskStatus("error");
      setStatusMessage(`打开结果失败：${String(error)}`);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon">
            <img src={appLogoUrl} alt="" aria-hidden="true" />
          </div>
          <div>
            <h1>文件夹压缩工具</h1>
            <p>RAR / 7-Zip 压缩工作台</p>
          </div>
        </div>
        <div className="header-tools">
          <ToolBadge ok={tools?.winrarExists ?? false} label="RAR" />
          <ToolBadge ok={tools?.sevenzExists ?? false} label="7-Zip" />
          <button className="toolbar-button" type="button" onClick={refreshTools} disabled={taskLocked}>
            <RotateCcw size={16} />
            检查
          </button>
          <button className="secondary-button" type="button" onClick={resetTask} disabled={taskLocked}>
            <RotateCcw size={17} />
            重置
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={startCompression}
            disabled={taskLocked}
          >
            <Play size={18} fill="currentColor" />
            {running ? "压缩中..." : "开始压缩"}
          </button>
          {running && (
            <button
              className="danger-button"
              type="button"
              onClick={cancelCompression}
              disabled={taskStatus === "cancelling"}
            >
              <X size={17} />
              {taskStatus === "cancelling" ? "取消中..." : "取消压缩"}
            </button>
          )}
        </div>
      </header>

      <nav className="tabbar" aria-label="工作区标签页">
        <TabButton
          active={activeTab === "task"}
          detail="拖拽文件夹、填写文章 ID、选择压缩方式"
          icon={<FolderArchive size={18} />}
          label="压缩任务"
          onClick={() => setActiveTab("task")}
        />
        <TabButton
          active={activeTab === "prefix"}
          detail={`${prefixRules.length} 条前缀规则`}
          icon={<Tag size={18} />}
          label="前缀规则"
          onClick={() => setActiveTab("prefix")}
        />
        <TabButton
          active={activeTab === "settings"}
          detail="程序路径、任务通知、运行日志"
          icon={<Settings2 size={18} />}
          label="设置与日志"
          onClick={() => setActiveTab("settings")}
        />
      </nav>

      <section className="tab-content">
        {activeTab === "task" && (
          <div className="task-layout">
            <section className="module source-module">
              <ModuleHeader index="1" title="源文件夹" detail={preview ? preview.path : "未选择"} />

              <button
                className={`drop-zone ${dragActive ? "is-active" : ""}`}
                onClick={chooseFolder}
                disabled={taskLocked}
                type="button"
              >
                <FolderArchive size={34} strokeWidth={1.7} />
                <span>{preview ? preview.name : "拖入文件夹 / 点击选择"}</span>
                <small>{preview ? formatSize(preview.sizeBytes) : "等待文件夹"}</small>
              </button>

              <div className="field-grid">
                <label className="field">
                  <span>文章 ID</span>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="142631"
                    value={articleId}
                    disabled={taskLocked}
                    onChange={(event) => setArticleId(event.currentTarget.value.replace(/\D/g, ""))}
                  />
                </label>
                <label className="field">
                  <span>分卷大小</span>
                  <input
                    className={volumeSizeError ? "invalid" : ""}
                    value={volumeSize}
                    disabled={taskLocked}
                    onChange={(event) => setVolumeSize(event.currentTarget.value)}
                  />
                  {volumeSizeError && <small className="field-error">{volumeSizeError}</small>}
                </label>
              </div>

              <div className="result-preview">
                <div>
                  <span>压缩包</span>
                  <strong title={archiveNameHint}>{archiveNameHint}</strong>
                </div>
                <div>
                  <span>输出目录</span>
                  <strong title={outputHint}>{outputHint}</strong>
                </div>
                <div>
                  <span>前缀规则</span>
                  <strong>
                    {prefixPreview?.matchedKeyword
                      ? `${prefixPreview.matchedKeyword} -> ${prefixPreview.archivePrefix}`
                      : "使用文件夹名"}
                  </strong>
                </div>
              </div>
            </section>

            <section className="module settings-module">
              <ModuleHeader index="2" title="压缩设置" detail="默认使用 RAR 命令行，可选 7-Zip 二次压缩" />

              <div className="option-grid">
                <OptionToggle
                  icon={<Layers size={17} />}
                  title="二次压缩"
                  description="RAR 后再生成 7z"
                  checked={secondCompression}
                  disabled={taskLocked}
                  onChange={setSecondCompression}
                />
                <OptionToggle
                  icon={<Trash2 size={17} />}
                  title="删除 RAR"
                  description="只保留 7z"
                  checked={deleteRar}
                  disabled={taskLocked || !secondCompression}
                  onChange={setDeleteRar}
                />
                <OptionToggle
                  icon={<ShieldCheck size={17} />}
                  title="后台模式"
                  description="隐藏压缩窗口"
                  checked={backgroundMode}
                  disabled={taskLocked}
                  onChange={setBackgroundMode}
                />
                <OptionToggle
                  icon={<Archive size={17} />}
                  title="分卷压缩"
                  description="超过 500MB"
                  checked={splitVolume}
                  disabled={taskLocked}
                  onChange={setSplitVolume}
                />
                <OptionToggle
                  icon={<FolderOpen size={17} />}
                  title="创建文件夹"
                  description="文章 ID 目录"
                  checked={createFolder}
                  disabled={taskLocked}
                  onChange={setCreateFolder}
                />
                <OptionToggle
                  icon={<Settings2 size={17} />}
                  title="强制创建"
                  description="始终创建目录"
                  checked={forceCreateFolder}
                  disabled={taskLocked}
                  onChange={setForceCreateFolder}
                />
                <OptionToggle
                  icon={<KeyRound size={17} />}
                  title="加密文件名"
                  description="RAR 内文件名隐藏"
                  checked={encryptFileNames}
                  disabled={taskLocked}
                  onChange={setEncryptFileNames}
                />
                <OptionToggle
                  icon={<Link2 size={17} />}
                  title="7z 跟随密码"
                  description="使用 RAR 密码"
                  checked={syncSevenzPassword}
                  disabled={taskLocked || !secondCompression}
                  onChange={setSyncSevenzPassword}
                />
              </div>

              <div className={`password-grid ${secondCompression ? "" : "single"}`}>
                <label className="field">
                  <span>RAR 密码</span>
                  <input
                    type="password"
                    value={rarPassword}
                    disabled={taskLocked}
                    onChange={(event) => setRarPassword(event.currentTarget.value)}
                    placeholder={
                      secondCompression && syncSevenzPassword ? "跟随 7z 时必填" : "不填写则不加密 RAR"
                    }
                  />
                </label>

                {secondCompression && (
                  <label className="field">
                    <span>7z 密码</span>
                    <input
                      type="password"
                      value={syncSevenzPassword ? rarPassword : sevenzPassword}
                      disabled={taskLocked || syncSevenzPassword}
                      onChange={(event) => setSevenzPassword(event.currentTarget.value)}
                      placeholder={syncSevenzPassword ? "跟随 RAR 密码" : "不填写则使用默认密码"}
                    />
                  </label>
                )}
              </div>
            </section>
          </div>
        )}

        {activeTab === "prefix" && (
          <div className="prefix-layout">
            <section className="module prefix-module">
              <div className="module-title-row">
                <div className="title-with-icon">
                  <Tag size={17} />
                  <span>压缩包前缀</span>
                  <span className="count-badge">{prefixRules.length}</span>
                </div>
                <button
                  className="toolbar-button compact-button"
                  type="button"
                  onClick={importPrefixRules}
                  disabled={taskLocked}
                >
                  <Upload size={15} />
                  导入
                </button>
              </div>

              <div className="rule-form">
                <input
                  placeholder="关键词，如 Nyako喵子"
                  value={ruleKeyword}
                  disabled={taskLocked}
                  onChange={(event) => setRuleKeyword(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addPrefixRule();
                  }}
                />
                <input
                  placeholder="前缀，如 nyako"
                  value={rulePrefix}
                  disabled={taskLocked}
                  onChange={(event) => setRulePrefix(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addPrefixRule();
                  }}
                />
                <button type="button" onClick={addPrefixRule} title="添加规则" disabled={taskLocked}>
                  <Plus size={15} />
                </button>
              </div>

              <label className="search-field">
                <Search size={15} />
                <input
                  placeholder="搜索前缀规则"
                  value={ruleSearch}
                  onChange={(event) => setRuleSearch(event.currentTarget.value)}
                />
              </label>

              <div className="rule-list expanded">
                {filteredRules.length === 0 ? (
                  <p className="empty-rules">暂无规则</p>
                ) : (
                  filteredRules.map((rule) => (
                    <div className="rule-item" key={rule.keyword}>
                      <span>{rule.keyword}</span>
                      <strong>{rule.prefix}</strong>
                      <button
                        type="button"
                        title="删除规则"
                        onClick={() => deletePrefixRule(rule.keyword)}
                        disabled={taskLocked}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>

            <aside className="module prefix-preview-module">
              <ModuleHeader index="预览" title="当前命名" detail={preview?.name ?? "选择文件夹后显示匹配结果"} />
              <div className="result-preview">
                <div>
                  <span>命中</span>
                  <strong>{prefixPreview?.matchedKeyword ?? "未命中"}</strong>
                </div>
                <div>
                  <span>前缀</span>
                  <strong>{prefixPreview?.archivePrefix ?? "未生成"}</strong>
                </div>
                <div>
                  <span>RAR</span>
                  <strong title={prefixPreview?.rarFileName}>{prefixPreview?.rarFileName ?? "未生成"}</strong>
                </div>
                <div>
                  <span>7z</span>
                  <strong title={prefixPreview?.sevenzFileName}>{prefixPreview?.sevenzFileName ?? "未生成"}</strong>
                </div>
              </div>
            </aside>
          </div>
        )}

        {activeTab === "settings" && (
          <div className="settings-layout">
            <div className="settings-stack">
              <section className="module path-module">
                <ModuleHeader index="路径" title="程序路径" detail="可直接填写 exe，或填写安装目录" />
                <label className="field compact">
                  <span>WinRAR/RAR</span>
                  <input
                    value={winrarPath}
                    disabled={taskLocked}
                    onChange={(event) => setWinrarPath(event.currentTarget.value)}
                  />
                </label>
                <label className="field compact">
                  <span>7-Zip</span>
                  <input
                    value={sevenzPath}
                    disabled={taskLocked}
                    onChange={(event) => setSevenzPath(event.currentTarget.value)}
                  />
                </label>
                <button className="toolbar-button path-check-button" type="button" onClick={refreshTools} disabled={taskLocked}>
                  <RotateCcw size={16} />
                  重新检查路径
                </button>
                {report && (
                  <button
                    className="secondary-button path-check-button"
                    type="button"
                    onClick={openResultLocation}
                  >
                    <FolderOpen size={17} />
                    打开结果目录
                  </button>
                )}
              </section>

              <section className="module notification-module">
                <ModuleHeader
                  index="通知"
                  title="任务通知"
                  detail={notificationSettings.enabled ? "由系统通知发送" : "已关闭"}
                />

                <div className="notification-status-row">
                  <span className={`permission-pill ${notificationSettings.enabled ? "ok" : "neutral"}`}>
                    {notificationSettings.enabled ? "系统通知" : "已关闭"}
                  </span>
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={testNotification}
                    disabled={notificationBusy || !notificationSettings.enabled}
                  >
                    <Send size={15} />
                    测试
                  </button>
                </div>

                <div className="option-grid notification-options">
                  <OptionToggle
                    icon={<Bell size={17} />}
                    title="启用通知"
                    description="任务结束时提醒"
                    checked={notificationSettings.enabled}
                    onChange={(checked) => updateNotificationSetting("enabled", checked)}
                  />
                  <OptionToggle
                    icon={<CheckCircle2 size={17} />}
                    title="成功通知"
                    description="压缩完成"
                    checked={notificationSettings.success}
                    disabled={!notificationSettings.enabled}
                    onChange={(checked) => updateNotificationSetting("success", checked)}
                  />
                  <OptionToggle
                    icon={<ShieldCheck size={17} />}
                    title="失败通知"
                    description="压缩出错"
                    checked={notificationSettings.failure}
                    disabled={!notificationSettings.enabled}
                    onChange={(checked) => updateNotificationSetting("failure", checked)}
                  />
                  <OptionToggle
                    icon={<X size={17} />}
                    title="取消通知"
                    description="任务被取消"
                    checked={notificationSettings.cancelled}
                    disabled={!notificationSettings.enabled}
                    onChange={(checked) => updateNotificationSetting("cancelled", checked)}
                  />
                </div>
              </section>
            </div>

            <section className="module log-module">
              <div className="module-title-row">
                <div className="title-with-icon">
                  <CheckCircle2 size={17} />
                  <span>任务日志</span>
                </div>
              </div>
              <div className="log-list">
                {logs.map((line, index) => (
                  <p key={`${line}-${index}`}>{line}</p>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>

      <footer className="statusbar">
        <div className="status-summary">
          <span className={statusDotClass} />
          <strong>{statusLabel}</strong>
          <span title={statusDetail}>{statusDetail}</span>
        </div>
        {report && (
          <button
            className="secondary-button"
            type="button"
            onClick={openResultLocation}
          >
            <FolderOpen size={17} />
            打开结果
          </button>
        )}
      </footer>
    </main>
  );
}

function TabButton({
  active,
  detail,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  detail: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`tab-button ${active ? "active" : ""}`} type="button" onClick={onClick}>
      <span className="tab-icon">{icon}</span>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function ModuleHeader({ detail, index, title }: { detail: string; index: string; title: string }) {
  return (
    <div className="module-header">
      <span>{index}</span>
      <div>
        <h2>{title}</h2>
        <p title={detail}>{detail}</p>
      </div>
    </div>
  );
}

function ToolBadge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`tool-badge ${ok ? "ok" : "bad"}`}>{label}</span>;
}

function OptionToggle({
  checked,
  description,
  disabled,
  icon,
  onChange,
  title,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  icon: React.ReactNode;
  onChange: (checked: boolean) => void;
  title: string;
}) {
  return (
    <label className={`option-toggle ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="option-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function sanitizePrefixInput(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function isValidVolumeSize(value: string) {
  return /^[1-9]\d*[bBkKmMgGtT]$/.test(value.trim());
}

function loadNotificationSettings(): NotificationSettings {
  const defaults: NotificationSettings = {
    enabled: true,
    success: true,
    failure: true,
    cancelled: true,
  };

  try {
    const raw = window.localStorage.getItem(notificationSettingsStorageKey);
    if (!raw) return defaults;

    const saved = JSON.parse(raw) as Partial<NotificationSettings>;
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : defaults.enabled,
      success: typeof saved.success === "boolean" ? saved.success : defaults.success,
      failure: typeof saved.failure === "boolean" ? saved.failure : defaults.failure,
      cancelled: typeof saved.cancelled === "boolean" ? saved.cancelled : defaults.cancelled,
    };
  } catch {
    return defaults;
  }
}

function saveNotificationSettings(settings: NotificationSettings) {
  try {
    window.localStorage.setItem(notificationSettingsStorageKey, JSON.stringify(settings));
  } catch {
    // localStorage can fail in restricted webviews; notification defaults still work.
  }
}

function shouldSendNotification(settings: NotificationSettings, kind: NotificationKind) {
  if (!settings.enabled) return false;
  return settings[kind];
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

export default App;
