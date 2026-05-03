use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::Manager;
use tauri_plugin_window_state::{StateFlags, WindowExt};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const DEFAULT_WINRAR_PATH: &str = r"G:\Software\WinRAR\WinRAR.exe";
const DEFAULT_7Z_PATH: &str = r"C:\Program Files\7-Zip\7z.exe";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const SPLIT_THRESHOLD_BYTES: u64 = 500 * 1024 * 1024;
const PREFIX_RULES_FILE: &str = "prefix-rules.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    winrar_path: String,
    winrar_exists: bool,
    sevenz_path: String,
    sevenz_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderPreview {
    path: String,
    name: String,
    parent: String,
    size_bytes: u64,
    size_mb: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrefixRule {
    keyword: String,
    prefix: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrefixPreview {
    folder_name: String,
    article_id: String,
    matched_keyword: Option<String>,
    archive_prefix: String,
    archive_stem: String,
    rar_file_name: String,
    sevenz_file_name: String,
    confidence: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompressionOptions {
    source_path: String,
    article_id: String,
    winrar_path: String,
    sevenz_path: String,
    second_compression: bool,
    delete_rar: bool,
    background_mode: bool,
    split_volume: bool,
    create_folder: bool,
    force_create_folder: bool,
    volume_size: String,
    sevenz_password: String,
    prefix_rules: Vec<PrefixRule>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandStep {
    name: String,
    command: String,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionReport {
    source_path: String,
    output_directory: String,
    rar_files: Vec<String>,
    sevenz_file: Option<String>,
    deleted_rar: bool,
    cleaned_outputs: Vec<String>,
    folder_size_bytes: u64,
    folder_size_mb: f64,
    used_split_volume: bool,
    matched_keyword: Option<String>,
    archive_prefix: String,
    archive_stem: String,
    steps: Vec<CommandStep>,
}

#[tauri::command]
fn resolve_tools(
    winrar_path: Option<String>,
    sevenz_path: Option<String>,
) -> Result<ToolStatus, String> {
    let winrar = resolve_rar_tool_path(
        winrar_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(DEFAULT_WINRAR_PATH),
    );
    let sevenz = resolve_tool_path(
        sevenz_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(DEFAULT_7Z_PATH),
        "7z.exe",
    );

    Ok(ToolStatus {
        winrar_exists: winrar.exists(),
        sevenz_exists: sevenz.exists(),
        winrar_path: winrar.to_string_lossy().to_string(),
        sevenz_path: sevenz.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn inspect_folder(path: String) -> Result<FolderPreview, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_folder_blocking(path))
        .await
        .map_err(|err| format!("文件夹检查任务中断：{err}"))?
}

fn inspect_folder_blocking(path: String) -> Result<FolderPreview, String> {
    let source_path = normalize_path(&path);
    ensure_folder(&source_path)?;

    let size_bytes = folder_size(&source_path)?;
    let parent = source_path
        .parent()
        .ok_or_else(|| "无法识别文件夹的父目录".to_string())?;

    Ok(FolderPreview {
        path: source_path.to_string_lossy().to_string(),
        name: source_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "folder".to_string()),
        parent: parent.to_string_lossy().to_string(),
        size_bytes,
        size_mb: bytes_to_mb(size_bytes),
    })
}

#[tauri::command]
fn load_prefix_rules(app: tauri::AppHandle) -> Result<Vec<PrefixRule>, String> {
    let path = prefix_rules_path(&app)?;
    let default_rules = default_prefix_rules()?;

    if !path.exists() {
        let json = serde_json::to_string_pretty(&default_rules)
            .map_err(|err| format!("序列化默认前缀规则失败：{err}"))?;
        fs::write(&path, json)
            .map_err(|err| format!("保存默认前缀规则失败：{} ({err})", path.to_string_lossy()))?;
        return Ok(default_rules);
    }

    let content = fs::read_to_string(&path)
        .map_err(|err| format!("读取前缀规则失败：{} ({err})", path.to_string_lossy()))?;
    let saved_rules = parse_prefix_rules(&content)?;
    let merged_rules = merge_prefix_rules(default_rules, saved_rules.clone());

    if merged_rules.len() != saved_rules.len() {
        let json = serde_json::to_string_pretty(&merged_rules)
            .map_err(|err| format!("序列化前缀规则失败：{err}"))?;
        fs::write(&path, json).map_err(|err| {
            format!(
                "保存补全后的前缀规则失败：{} ({err})",
                path.to_string_lossy()
            )
        })?;
    }

    Ok(merged_rules)
}

#[tauri::command]
fn save_prefix_rules(
    app: tauri::AppHandle,
    rules: Vec<PrefixRule>,
) -> Result<Vec<PrefixRule>, String> {
    let normalized = normalize_prefix_rules(rules);
    let path = prefix_rules_path(&app)?;
    let json = serde_json::to_string_pretty(&normalized)
        .map_err(|err| format!("序列化前缀规则失败：{err}"))?;

    fs::write(&path, json)
        .map_err(|err| format!("保存前缀规则失败：{} ({err})", path.to_string_lossy()))?;

    Ok(normalized)
}

#[tauri::command]
fn import_prefix_rules(
    app: tauri::AppHandle,
    path: String,
    merge: bool,
) -> Result<Vec<PrefixRule>, String> {
    let import_path = normalize_path(&path);
    let content = fs::read_to_string(&import_path).map_err(|err| {
        format!(
            "读取导入文件失败：{} ({err})",
            import_path.to_string_lossy()
        )
    })?;
    let imported = parse_prefix_rules(&content)?;

    let next_rules = if merge {
        let existing = load_prefix_rules(app.clone())?;
        merge_prefix_rules(existing, imported)
    } else {
        normalize_prefix_rules(imported)
    };

    save_prefix_rules(app, next_rules)
}

#[tauri::command]
fn preview_prefix(
    folder_name: String,
    article_id: String,
    rules: Vec<PrefixRule>,
) -> Result<PrefixPreview, String> {
    Ok(build_prefix_preview(&folder_name, &article_id, &rules))
}

#[tauri::command]
async fn compress_folder(options: CompressionOptions) -> Result<CompressionReport, String> {
    tauri::async_runtime::spawn_blocking(move || compress_folder_blocking(options))
        .await
        .map_err(|err| format!("压缩任务中断：{err}"))?
}

fn compress_folder_blocking(options: CompressionOptions) -> Result<CompressionReport, String> {
    let source_path = normalize_path(&options.source_path);
    ensure_folder(&source_path)?;

    let article_id = options.article_id.trim();
    if article_id.is_empty() || !article_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("文章 ID 必须填写，并且只能是数字".to_string());
    }

    let winrar_path = resolve_rar_tool_path(&options.winrar_path);
    if !winrar_path.exists() {
        return Err(format!(
            "找不到 WinRAR/Rar.exe：{}",
            winrar_path.to_string_lossy()
        ));
    }

    let sevenz_path = resolve_tool_path(&options.sevenz_path, "7z.exe");
    if options.second_compression && !sevenz_path.exists() {
        return Err(format!(
            "已启用二次压缩，但找不到 7-Zip：{}",
            sevenz_path.to_string_lossy()
        ));
    }

    let folder_size_bytes = folder_size(&source_path)?;
    let used_split_volume = options.split_volume && folder_size_bytes > SPLIT_THRESHOLD_BYTES;
    let should_create_folder =
        options.create_folder || options.force_create_folder || used_split_volume;

    let parent_dir = source_path
        .parent()
        .ok_or_else(|| "无法识别文件夹的父目录".to_string())?;
    let output_dir = if should_create_folder {
        let dir = parent_dir.join(article_id);
        fs::create_dir_all(&dir)
            .map_err(|err| format!("创建输出文件夹失败：{} ({err})", dir.to_string_lossy()))?;
        dir
    } else {
        parent_dir.to_path_buf()
    };

    if paths_match(&output_dir, &source_path) {
        return Err("输出文件夹不能和源文件夹相同，请换一个文章 ID".to_string());
    }

    let folder_name = source_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "folder".to_string());
    let prefix_preview = build_prefix_preview(&folder_name, article_id, &options.prefix_rules);
    let archive_base = prefix_preview.archive_stem.clone();
    let rar_output = output_dir.join(format!("{archive_base}.rar"));
    let sevenz_output = output_dir.join(format!("{archive_base}.7z"));

    let mut steps = Vec::new();
    let cleaned_outputs =
        cleanup_previous_outputs(&output_dir, &archive_base, &rar_output, &sevenz_output)?;

    let rar_args = build_rar_args(
        &options,
        &winrar_path,
        &rar_output,
        &source_path,
        used_split_volume,
    )?;
    let rar_step = run_command(
        "WinRAR",
        &winrar_path,
        &rar_args,
        options.background_mode,
        None,
    )?;
    steps.push(rar_step);

    let rar_files = collect_rar_outputs(&output_dir, &archive_base, &rar_output)?;
    if rar_files.is_empty() {
        return Err("WinRAR 已结束，但没有找到生成的 RAR 文件".to_string());
    }

    let mut sevenz_file = None;
    let mut deleted_rar = false;

    if options.second_compression {
        let password = if options.sevenz_password.trim().is_empty() {
            "moeuu.xyz"
        } else {
            options.sevenz_password.trim()
        };
        let sevenz_args = build_7z_args(&sevenz_output, &rar_files, password);
        let sevenz_step = run_command(
            "7-Zip",
            &sevenz_path,
            &sevenz_args,
            options.background_mode,
            Some(password),
        )?;
        steps.push(sevenz_step);

        let verify_args = vec![
            OsString::from("t"),
            OsString::from("-t7z"),
            OsString::from(format!("-p{password}")),
            OsString::from("-y"),
            sevenz_output.as_os_str().to_os_string(),
        ];
        let verify_step = run_command(
            "7-Zip 验证",
            &sevenz_path,
            &verify_args,
            options.background_mode,
            Some(password),
        )?;
        steps.push(verify_step);

        sevenz_file = Some(sevenz_output.to_string_lossy().to_string());

        if options.delete_rar {
            for rar_file in &rar_files {
                fs::remove_file(rar_file).map_err(|err| {
                    format!("删除 RAR 文件失败：{} ({err})", rar_file.to_string_lossy())
                })?;
            }
            deleted_rar = true;
        }
    }

    Ok(CompressionReport {
        source_path: source_path.to_string_lossy().to_string(),
        output_directory: output_dir.to_string_lossy().to_string(),
        rar_files: rar_files
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        sevenz_file,
        deleted_rar,
        cleaned_outputs: cleaned_outputs
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        folder_size_bytes,
        folder_size_mb: bytes_to_mb(folder_size_bytes),
        used_split_volume,
        matched_keyword: prefix_preview.matched_keyword,
        archive_prefix: prefix_preview.archive_prefix,
        archive_stem: prefix_preview.archive_stem,
        steps,
    })
}

fn prefix_rules_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("获取应用配置目录失败：{err}"))?;
    fs::create_dir_all(&config_dir).map_err(|err| {
        format!(
            "创建应用配置目录失败：{} ({err})",
            config_dir.to_string_lossy()
        )
    })?;
    Ok(config_dir.join(PREFIX_RULES_FILE))
}

fn default_prefix_rules() -> Result<Vec<PrefixRule>, String> {
    parse_prefix_rules(include_str!("../default-prefix-rules.json"))
}

fn parse_prefix_rules(content: &str) -> Result<Vec<PrefixRule>, String> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|err| format!("前缀规则 JSON 格式错误：{err}"))?;

    let rules = match value {
        serde_json::Value::Array(_) => serde_json::from_value::<Vec<PrefixRule>>(value)
            .map_err(|err| format!("前缀规则数组格式错误：{err}"))?,
        serde_json::Value::Object(map) => map
            .into_iter()
            .map(|(keyword, value)| PrefixRule {
                keyword,
                prefix: value.as_str().unwrap_or_default().to_string(),
            })
            .collect(),
        _ => {
            return Err("前缀规则必须是数组，或旧版的关键词到前缀 JSON 对象".to_string());
        }
    };

    Ok(normalize_prefix_rules(rules))
}

fn normalize_prefix_rules(rules: Vec<PrefixRule>) -> Vec<PrefixRule> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for rule in rules {
        let keyword = rule.keyword.trim().to_string();
        let prefix = sanitize_archive_prefix(&rule.prefix);

        if keyword.is_empty() || prefix.is_empty() {
            continue;
        }

        let key = keyword.to_lowercase();
        if seen.contains(&key) {
            continue;
        }

        seen.insert(key);
        normalized.push(PrefixRule { keyword, prefix });
    }

    normalized
}

fn merge_prefix_rules(existing: Vec<PrefixRule>, imported: Vec<PrefixRule>) -> Vec<PrefixRule> {
    let mut merged = normalize_prefix_rules(existing);

    for rule in normalize_prefix_rules(imported) {
        let key = rule.keyword.to_lowercase();
        if let Some(position) = merged
            .iter()
            .position(|current| current.keyword.to_lowercase() == key)
        {
            merged[position] = rule;
        } else {
            merged.push(rule);
        }
    }

    merged
}

fn build_prefix_preview(
    folder_name: &str,
    article_id: &str,
    rules: &[PrefixRule],
) -> PrefixPreview {
    let prefix_match = find_prefix_match(folder_name, rules);
    let archive_prefix = prefix_match
        .as_ref()
        .map(|item| item.rule.prefix.clone())
        .unwrap_or_else(|| sanitize_archive_prefix(folder_name));
    let archive_prefix = if archive_prefix.is_empty() {
        "folder".to_string()
    } else {
        archive_prefix
    };
    let archive_stem = compose_archive_stem(&archive_prefix, article_id);

    PrefixPreview {
        folder_name: folder_name.to_string(),
        article_id: article_id.trim().to_string(),
        matched_keyword: prefix_match.as_ref().map(|item| item.rule.keyword.clone()),
        archive_prefix,
        rar_file_name: format!("{archive_stem}.rar"),
        sevenz_file_name: format!("{archive_stem}.7z"),
        archive_stem,
        confidence: prefix_match.map(|item| item.confidence).unwrap_or(0.0),
    }
}

#[derive(Debug)]
struct PrefixMatch {
    rule: PrefixRule,
    confidence: f64,
    position: usize,
}

fn find_prefix_match(folder_name: &str, rules: &[PrefixRule]) -> Option<PrefixMatch> {
    let folder_lower = folder_name.to_lowercase();
    let mut best: Option<PrefixMatch> = None;

    for rule in normalize_prefix_rules(rules.to_vec()) {
        let keyword_lower = rule.keyword.to_lowercase();
        let Some(position) = folder_lower.find(&keyword_lower) else {
            continue;
        };

        let confidence =
            calculate_prefix_confidence(folder_name, &folder_lower, &keyword_lower, position);
        let candidate = PrefixMatch {
            rule,
            confidence,
            position,
        };

        let should_replace = match &best {
            None => true,
            Some(current) => {
                candidate.confidence > current.confidence
                    || ((candidate.confidence - current.confidence).abs() < f64::EPSILON
                        && candidate.rule.keyword.chars().count()
                            > current.rule.keyword.chars().count())
                    || ((candidate.confidence - current.confidence).abs() < f64::EPSILON
                        && candidate.rule.keyword.chars().count()
                            == current.rule.keyword.chars().count()
                        && candidate.position < current.position)
            }
        };

        if should_replace {
            best = Some(candidate);
        }
    }

    best
}

fn calculate_prefix_confidence(
    folder_name: &str,
    folder_lower: &str,
    keyword_lower: &str,
    position: usize,
) -> f64 {
    let trimmed = folder_lower.trim();
    let mut confidence: f64 = if trimmed == keyword_lower {
        1.0
    } else if starts_with_wrapped_keyword(trimmed, keyword_lower)
        || contains_wrapped_keyword(trimmed, keyword_lower)
    {
        0.96
    } else if trimmed.starts_with(keyword_lower) {
        0.9
    } else {
        0.74
    };

    let folder_len = folder_name.chars().count().max(1) as f64;
    let position_chars = folder_lower[..position].chars().count() as f64;
    confidence *= 1.0 - (position_chars / folder_len * 0.08);
    confidence.clamp(0.0, 1.0)
}

fn starts_with_wrapped_keyword(folder_name: &str, keyword: &str) -> bool {
    ["[", "【", "(", "（"]
        .iter()
        .any(|open| folder_name.starts_with(&format!("{open}{keyword}")))
}

fn contains_wrapped_keyword(folder_name: &str, keyword: &str) -> bool {
    [
        format!("[{keyword}]"),
        format!("【{keyword}】"),
        format!("({keyword})"),
        format!("（{keyword}）"),
    ]
    .iter()
    .any(|pattern| folder_name.contains(pattern))
}

fn compose_archive_stem(prefix: &str, article_id: &str) -> String {
    let prefix = sanitize_archive_prefix(prefix);
    let article_id = article_id.trim();

    if article_id.is_empty() {
        prefix
    } else {
        format!(
            "{}_{}",
            prefix.trim_end_matches(|ch| ch == '_' || ch == '-'),
            article_id
        )
    }
}

fn build_rar_args(
    options: &CompressionOptions,
    program: &Path,
    rar_output: &Path,
    source_path: &Path,
    used_split_volume: bool,
) -> Result<Vec<OsString>, String> {
    let mut args = vec![
        OsString::from("a"),
        OsString::from("-ep1"),
        OsString::from("-r"),
        OsString::from("-t"),
        OsString::from("-x*.tmp"),
        OsString::from("-x*.temp"),
        OsString::from("-x*~"),
    ];

    if options.background_mode && is_winrar_gui(program) {
        args.push(OsString::from("-ibck"));
    }

    if used_split_volume {
        let volume_size = normalize_volume_size(&options.volume_size)?;
        args.push(OsString::from(format!("-v{volume_size}")));
    }

    args.push(rar_output.as_os_str().to_os_string());
    args.push(source_path.as_os_str().to_os_string());
    Ok(args)
}

fn build_7z_args(sevenz_output: &Path, rar_files: &[PathBuf], password: &str) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("a"),
        OsString::from("-t7z"),
        OsString::from("-mx=9"),
        OsString::from("-m0=lzma2"),
        OsString::from("-md=64m"),
        OsString::from("-ms=on"),
        OsString::from(format!("-p{password}")),
        OsString::from("-mhe=on"),
        OsString::from("-y"),
        sevenz_output.as_os_str().to_os_string(),
    ];

    for rar_file in rar_files {
        args.push(rar_file.as_os_str().to_os_string());
    }

    args
}

fn run_command(
    name: &str,
    program: &Path,
    args: &[OsString],
    hidden: bool,
    password: Option<&str>,
) -> Result<CommandStep, String> {
    let command_line = render_command(program, args, password);
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    if hidden {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|err| format!("{name} 启动失败：{command_line}\n{err}"))?;

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(format!(
            "{name} 压缩失败，退出码 {exit_code}\n命令：{command_line}\n输出：{}\n错误：{}",
            if stdout.is_empty() { "(无)" } else { &stdout },
            if stderr.is_empty() { "(无)" } else { &stderr }
        ));
    }

    Ok(CommandStep {
        name: name.to_string(),
        command: command_line,
        exit_code,
        stdout,
        stderr,
    })
}

fn collect_rar_outputs(
    output_dir: &Path,
    archive_base: &str,
    rar_output: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();

    if rar_output.exists() {
        files.push(rar_output.to_path_buf());
    }

    let part_prefix = format!("{archive_base}.part");
    let entries = fs::read_dir(output_dir).map_err(|err| {
        format!(
            "读取输出文件夹失败：{} ({err})",
            output_dir.to_string_lossy()
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("读取输出文件失败：{err}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
            continue;
        };

        if file_name.starts_with(&part_prefix) && file_name.ends_with(".rar") {
            files.push(path);
        }
    }

    files.sort();
    files.dedup();
    Ok(files)
}

fn cleanup_previous_outputs(
    output_dir: &Path,
    archive_base: &str,
    rar_output: &Path,
    sevenz_output: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut targets = Vec::new();

    if rar_output.exists() {
        targets.push(rar_output.to_path_buf());
    }

    if sevenz_output.exists() {
        targets.push(sevenz_output.to_path_buf());
    }

    let part_prefix = format!("{archive_base}.part");
    let entries = fs::read_dir(output_dir).map_err(|err| {
        format!(
            "读取输出文件夹失败：{} ({err})",
            output_dir.to_string_lossy()
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("读取旧输出文件失败：{err}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let Some(file_name) = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
            continue;
        };

        if file_name.starts_with(&part_prefix) && file_name.ends_with(".rar") {
            targets.push(path);
        }
    }

    targets.sort();
    targets.dedup();

    for target in &targets {
        fs::remove_file(target)
            .map_err(|err| format!("清理旧输出文件失败：{} ({err})", target.to_string_lossy()))?;
    }

    Ok(targets)
}

fn folder_size(path: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("读取路径失败：{} ({err})", path.to_string_lossy()))?;

    if metadata.file_type().is_symlink() {
        return Ok(0);
    }

    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0_u64;
    let entries = fs::read_dir(path)
        .map_err(|err| format!("扫描文件夹失败：{} ({err})", path.to_string_lossy()))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("读取文件夹项目失败：{err}"))?;
        total = total.saturating_add(folder_size(&entry.path())?);
    }

    Ok(total)
}

fn normalize_path(path: &str) -> PathBuf {
    let trimmed = path.trim().trim_matches('"');
    PathBuf::from(trimmed)
}

fn resolve_tool_path(path: &str, executable_name: &str) -> PathBuf {
    let candidate = normalize_path(path);
    if candidate.is_dir() {
        candidate.join(executable_name)
    } else {
        candidate
    }
}

fn resolve_rar_tool_path(path: &str) -> PathBuf {
    let candidate = normalize_path(path);

    if candidate.is_dir() {
        let rar = candidate.join("Rar.exe");
        if rar.exists() {
            return rar;
        }
        return candidate.join("WinRAR.exe");
    }

    if is_winrar_gui(&candidate) {
        if let Some(parent) = candidate.parent() {
            let rar = parent.join("Rar.exe");
            if rar.exists() {
                return rar;
            }
        }
    }

    candidate
}

fn is_winrar_gui(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("WinRAR.exe"))
        .unwrap_or(false)
}

fn normalize_volume_size(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok("500m".to_string());
    }

    let mut chars = value.chars().peekable();
    let mut digits = String::new();

    while let Some(ch) = chars.peek().copied() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            chars.next();
        } else {
            break;
        }
    }

    let Some(unit) = chars.next() else {
        return Err("分卷大小需要带单位，例如 500m、1g、102400k".to_string());
    };

    if chars.next().is_some()
        || digits.is_empty()
        || digits.chars().all(|ch| ch == '0')
        || !matches!(
            unit,
            'b' | 'B' | 'k' | 'K' | 'm' | 'M' | 'g' | 'G' | 't' | 'T'
        )
    {
        return Err("分卷大小格式不正确，请使用 500m、1g、102400k 这类格式".to_string());
    }

    Ok(format!("{}{}", digits, unit))
}

fn ensure_folder(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("文件夹不存在：{}", path.to_string_lossy()));
    }

    if !path.is_dir() {
        return Err(format!(
            "请选择文件夹，而不是文件：{}",
            path.to_string_lossy()
        ));
    }

    Ok(())
}

fn sanitize_archive_prefix(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .filter(|ch| !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .filter(|ch| !ch.is_control())
        .collect();

    sanitized
        .trim()
        .trim_matches('.')
        .trim_matches(|ch| ch == '_' || ch == '-')
        .trim()
        .to_string()
}

fn paths_match(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn render_command(program: &Path, args: &[OsString], password: Option<&str>) -> String {
    let mut parts = vec![quote_arg(&program.to_string_lossy())];
    for arg in args {
        let mut value = arg.to_string_lossy().to_string();
        if let Some(password) = password {
            value = value.replace(password, "******");
        }
        if value.starts_with("-p") && value.len() > 2 {
            value = "-p******".to_string();
        }
        parts.push(quote_arg(&value));
    }
    parts.join(" ")
}

fn quote_arg(value: &str) -> String {
    if value.contains(' ') || value.contains('\\') || value.contains(':') {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

fn bytes_to_mb(bytes: u64) -> f64 {
    bytes as f64 / 1024_f64 / 1024_f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_custom_prefix_and_composes_archive_name() {
        let rules = vec![PrefixRule {
            keyword: "Nyako喵子".to_string(),
            prefix: "nyako_".to_string(),
        }];

        let preview = build_prefix_preview("[Nyako喵子] 夏日写真", "142631", &rules);

        assert_eq!(preview.matched_keyword.as_deref(), Some("Nyako喵子"));
        assert_eq!(preview.archive_prefix, "nyako");
        assert_eq!(preview.archive_stem, "nyako_142631");
        assert_eq!(preview.rar_file_name, "nyako_142631.rar");
    }

    #[test]
    fn imports_legacy_keyword_mapping_object() {
        let json = r#"{
            "清水由乃": "qsyoun_",
            "Nyako喵子": "nyako_"
        }"#;

        let rules = parse_prefix_rules(json).expect("legacy JSON should parse");
        let preview = build_prefix_preview("Nyako喵子 合集", "142631", &rules);

        assert_eq!(rules.len(), 2);
        assert_eq!(preview.archive_stem, "nyako_142631");
    }

    #[test]
    fn uses_longer_keyword_when_scores_tie() {
        let rules = vec![
            PrefixRule {
                keyword: "Nyako".to_string(),
                prefix: "nya".to_string(),
            },
            PrefixRule {
                keyword: "Nyako喵子".to_string(),
                prefix: "nyako".to_string(),
            },
        ];

        let preview = build_prefix_preview("Nyako喵子", "1", &rules);

        assert_eq!(preview.matched_keyword.as_deref(), Some("Nyako喵子"));
        assert_eq!(preview.archive_stem, "nyako_1");
    }

    #[test]
    fn bundled_default_rules_include_legacy_mappings() {
        let rules = default_prefix_rules().expect("bundled defaults should parse");
        let preview = build_prefix_preview("清水凪 合集", "9988", &rules);

        assert_eq!(rules.len(), 67);
        assert_eq!(preview.archive_stem, "qshuiz_9988");
    }

    #[test]
    fn trims_extra_dash_from_prefix() {
        let rules = vec![PrefixRule {
            keyword: "测试".to_string(),
            prefix: "demo-_".to_string(),
        }];
        let preview = build_prefix_preview("测试 文件夹", "123", &rules);

        assert_eq!(preview.archive_prefix, "demo");
        assert_eq!(preview.archive_stem, "demo_123");
    }

    #[test]
    fn winrar_args_enable_archive_test() {
        let options = CompressionOptions {
            source_path: String::new(),
            article_id: String::new(),
            winrar_path: String::new(),
            sevenz_path: String::new(),
            second_compression: false,
            delete_rar: false,
            background_mode: false,
            split_volume: false,
            create_folder: false,
            force_create_folder: false,
            volume_size: "500m".to_string(),
            sevenz_password: String::new(),
            prefix_rules: Vec::new(),
        };

        let args = build_rar_args(
            &options,
            Path::new("Rar.exe"),
            Path::new("output.rar"),
            Path::new("source-folder"),
            false,
        )
        .expect("RAR args should build");

        assert!(args.iter().any(|arg| arg == "-t"));
    }

    #[test]
    fn rar_args_skip_winrar_background_switch_for_console_rar() {
        let options = CompressionOptions {
            source_path: String::new(),
            article_id: String::new(),
            winrar_path: String::new(),
            sevenz_path: String::new(),
            second_compression: false,
            delete_rar: false,
            background_mode: true,
            split_volume: false,
            create_folder: false,
            force_create_folder: false,
            volume_size: "500m".to_string(),
            sevenz_password: String::new(),
            prefix_rules: Vec::new(),
        };

        let rar_args = build_rar_args(
            &options,
            Path::new("Rar.exe"),
            Path::new("output.rar"),
            Path::new("source-folder"),
            false,
        )
        .expect("RAR args should build");
        let winrar_args = build_rar_args(
            &options,
            Path::new("WinRAR.exe"),
            Path::new("output.rar"),
            Path::new("source-folder"),
            false,
        )
        .expect("WinRAR args should build");

        assert!(!rar_args.iter().any(|arg| arg == "-ibck"));
        assert!(winrar_args.iter().any(|arg| arg == "-ibck"));
    }

    #[test]
    fn validates_volume_size_format() {
        assert_eq!(normalize_volume_size("").unwrap(), "500m");
        assert_eq!(normalize_volume_size("500m").unwrap(), "500m");
        assert_eq!(normalize_volume_size("1g").unwrap(), "1g");
        assert_eq!(normalize_volume_size("102400k").unwrap(), "102400k");

        assert!(normalize_volume_size("500").is_err());
        assert!(normalize_volume_size("abc").is_err());
        assert!(normalize_volume_size("0m").is_err());
        assert!(normalize_volume_size("500 mb").is_err());
    }

    #[test]
    fn prefers_rar_exe_next_to_winrar_exe() {
        let dir =
            std::env::temp_dir().join(format!("folder-compression-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir should be created");

        let winrar = dir.join("WinRAR.exe");
        let rar = dir.join("Rar.exe");
        fs::write(&winrar, "").expect("WinRAR marker should be written");
        fs::write(&rar, "").expect("RAR marker should be written");

        assert_eq!(resolve_rar_tool_path(&winrar.to_string_lossy()), rar);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_previous_outputs_removes_stale_archives() {
        let dir = std::env::temp_dir().join(format!(
            "folder-compression-cleanup-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir should be created");

        let rar = dir.join("demo_1.rar");
        let sevenz = dir.join("demo_1.7z");
        let part = dir.join("demo_1.part1.rar");
        let unrelated = dir.join("demo_1-note.rar");
        for file in [&rar, &sevenz, &part, &unrelated] {
            fs::write(file, "old").expect("old output should be written");
        }

        let cleaned = cleanup_previous_outputs(&dir, "demo_1", &rar, &sevenz)
            .expect("cleanup should succeed");

        assert_eq!(cleaned.len(), 3);
        assert!(!rar.exists());
        assert!(!sevenz.exists());
        assert!(!part.exists());
        assert!(unrelated.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sevenz_args_explicitly_create_7z_archive() {
        let rar_files = vec![PathBuf::from("input.rar")];
        let args = build_7z_args(Path::new("output.7z"), &rar_files, "secret");

        assert!(args.iter().any(|arg| arg == "-t7z"));
        assert!(args.iter().any(|arg| arg == "-mx=9"));
        assert!(args.iter().any(|arg| arg == "-m0=lzma2"));
        assert!(args.iter().any(|arg| arg == "-mhe=on"));
        assert!(args.iter().any(|arg| arg == "-y"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window
                    .restore_state(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED);
                window.show()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_tools,
            inspect_folder,
            load_prefix_rules,
            save_prefix_rules,
            import_prefix_rules,
            preview_prefix,
            compress_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
