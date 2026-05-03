import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Archive,
  CheckCircle2,
  FolderArchive,
  FolderOpen,
  Layers,
  Play,
  Plus,
  RotateCcw,
  Search,
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

const defaultWinrarPath = "G:\\Software\\WinRAR\\WinRAR.exe";
const defaultSevenzPath = "C:\\Program Files\\7-Zip\\7z.exe";

function App() {
  const folderRequestId = useRef(0);
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

  useEffect(() => {
    refreshTools();
    loadPrefixRules();
  }, []);

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
    const nextRules = prefixRules.filter(
      (rule) => rule.keyword.toLowerCase() !== keyword.toLowerCase(),
    );
    await persistPrefixRules(nextRules, `已删除前缀规则：${keyword}`);
  }

  async function importPrefixRules() {
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

    try {
      const nextPreview = await invoke<FolderPreview>("inspect_folder", { path });
      if (requestId !== folderRequestId.current) return;

      setPreview(nextPreview);
      if (announce) {
        setReport(null);
        appendLog(`已选择：${nextPreview.name}（${formatSize(nextPreview.sizeBytes)}）`);
      }
    } catch (error) {
      if (requestId !== folderRequestId.current) return;

      setPreview(null);
      if (announce) {
        appendLog(`选择失败：${String(error)}`);
      }
    }
  }

  async function startCompression() {
    if (running) return;
    setReport(null);

    if (!sourcePath.trim()) {
      appendLog("请先拖入或选择一个文件夹。");
      return;
    }

    if (!articleId.trim()) {
      appendLog("文章 ID 必填。");
      return;
    }

    if (volumeSizeError) {
      appendLog(volumeSizeError);
      return;
    }

    setRunning(true);
    appendLog("开始压缩任务。");

    try {
      const result = await invoke<CompressionReport>("compress_folder", {
        options: {
          sourcePath,
          articleId,
          winrarPath,
          sevenzPath,
          secondCompression,
          deleteRar,
          backgroundMode,
          splitVolume,
          createFolder,
          forceCreateFolder,
          volumeSize,
          sevenzPassword,
          prefixRules,
        },
      });

      setReport(result);
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
      void sendSystemNotification("压缩完成", `${result.archiveStem} 已生成。`);
    } catch (error) {
      const message = String(error);
      appendLog(`压缩失败：${message}`);
      void sendSystemNotification("压缩失败", "查看任务日志获取详情。");
    } finally {
      setRunning(false);
    }
  }

  function resetTask() {
    folderRequestId.current += 1;
    setSourcePath("");
    setPreview(null);
    setPrefixPreview(null);
    setReport(null);
    setLogs(["等待拖入文件夹。"]);
  }

  function appendLog(message: string) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setLogs((current) => [`${time}  ${message}`, ...current].slice(0, 80));
  }

  async function sendSystemNotification(title: string, body: string) {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }

      if (granted) {
        sendNotification({ title, body });
      }
    } catch (error) {
      appendLog(`系统通知发送失败：${String(error)}`);
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
            <p>WinRAR / 7-Zip 压缩工作台</p>
          </div>
        </div>
        <div className="header-tools">
          <ToolBadge ok={tools?.winrarExists ?? false} label="WinRAR" />
          <ToolBadge ok={tools?.sevenzExists ?? false} label="7-Zip" />
          <button className="toolbar-button" type="button" onClick={refreshTools}>
            <RotateCcw size={16} />
            检查
          </button>
          <button className="secondary-button" type="button" onClick={resetTask} disabled={running}>
            <RotateCcw size={17} />
            重置
          </button>
          <button className="primary-button" type="button" onClick={startCompression} disabled={running}>
            <Play size={18} fill="currentColor" />
            {running ? "压缩中..." : "开始压缩"}
          </button>
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
          detail="程序路径、运行日志、结果定位"
          icon={<Settings2 size={18} />}
          label="路径与日志"
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
                    onChange={(event) => setArticleId(event.currentTarget.value.replace(/\D/g, ""))}
                  />
                </label>
                <label className="field">
                  <span>分卷大小</span>
                  <input
                    className={volumeSizeError ? "invalid" : ""}
                    value={volumeSize}
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
              <ModuleHeader index="2" title="压缩设置" detail="默认使用 WinRAR，可选 7-Zip 二次压缩" />

              <div className="option-grid">
                <OptionToggle
                  icon={<Layers size={17} />}
                  title="二次压缩"
                  description="RAR 后再生成 7z"
                  checked={secondCompression}
                  onChange={setSecondCompression}
                />
                <OptionToggle
                  icon={<Trash2 size={17} />}
                  title="删除 RAR"
                  description="只保留 7z"
                  checked={deleteRar}
                  disabled={!secondCompression}
                  onChange={setDeleteRar}
                />
                <OptionToggle
                  icon={<ShieldCheck size={17} />}
                  title="后台模式"
                  description="隐藏压缩窗口"
                  checked={backgroundMode}
                  onChange={setBackgroundMode}
                />
                <OptionToggle
                  icon={<Archive size={17} />}
                  title="分卷压缩"
                  description="超过 500MB"
                  checked={splitVolume}
                  onChange={setSplitVolume}
                />
                <OptionToggle
                  icon={<FolderOpen size={17} />}
                  title="创建文件夹"
                  description="文章 ID 目录"
                  checked={createFolder}
                  onChange={setCreateFolder}
                />
                <OptionToggle
                  icon={<Settings2 size={17} />}
                  title="强制创建"
                  description="始终创建目录"
                  checked={forceCreateFolder}
                  onChange={setForceCreateFolder}
                />
              </div>

              {secondCompression && (
                <label className="field">
                  <span>7z 密码</span>
                  <input
                    value={sevenzPassword}
                    onChange={(event) => setSevenzPassword(event.currentTarget.value)}
                  />
                </label>
              )}
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
                <button className="toolbar-button compact-button" type="button" onClick={importPrefixRules}>
                  <Upload size={15} />
                  导入
                </button>
              </div>

              <div className="rule-form">
                <input
                  placeholder="关键词，如 Nyako喵子"
                  value={ruleKeyword}
                  onChange={(event) => setRuleKeyword(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addPrefixRule();
                  }}
                />
                <input
                  placeholder="前缀，如 nyako"
                  value={rulePrefix}
                  onChange={(event) => setRulePrefix(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addPrefixRule();
                  }}
                />
                <button type="button" onClick={addPrefixRule} title="添加规则">
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
                      <button type="button" title="删除规则" onClick={() => deletePrefixRule(rule.keyword)}>
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
            <section className="module path-module">
              <ModuleHeader index="路径" title="程序路径" detail="可直接填写 exe，或填写安装目录" />
              <label className="field compact">
                <span>WinRAR</span>
                <input value={winrarPath} onChange={(event) => setWinrarPath(event.currentTarget.value)} />
              </label>
              <label className="field compact">
                <span>7-Zip</span>
                <input value={sevenzPath} onChange={(event) => setSevenzPath(event.currentTarget.value)} />
              </label>
              <button className="toolbar-button path-check-button" type="button" onClick={refreshTools}>
                <RotateCcw size={16} />
                重新检查路径
              </button>
              {report && (
                <button
                  className="secondary-button path-check-button"
                  type="button"
                  onClick={() => revealItemInDir(report.sevenzFile ?? report.rarFiles[0] ?? report.outputDirectory)}
                >
                  <FolderOpen size={17} />
                  打开结果目录
                </button>
              )}
            </section>

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
          <span className={running ? "status-dot busy" : "status-dot"} />
          <strong>{running ? "压缩中" : report ? "已完成" : "就绪"}</strong>
          <span>{report?.archiveStem ?? archiveNameHint}</span>
        </div>
        {report && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => revealItemInDir(report.sevenzFile ?? report.rarFiles[0] ?? report.outputDirectory)}
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
