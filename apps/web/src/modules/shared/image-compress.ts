/**
 * 上传前把图片压小再转 base64。
 *
 * 背景（2026-08-08 线上事故）：
 * 仓库版集货「签收」上传入库照片时，前端把原图直接转成 base64 一起 POST，
 * base64 还会再胖 33%，几张手机照片轻松超过 1MB —— 被 nginx 的 client_max_body_size
 * 默认值挡在门外，返回 413，请求根本没进到后端，后端日志里一条记录都没有。
 *
 * nginx 那边已放宽到 20MB，但光放宽不够：
 * 单张上限 5MB × 多张，仍然可能超过后端自己的 20MB 上限，而且上传会很慢。
 * 所以上传前一律先压。
 *
 * 压缩策略：
 *   1. 长边超过 MAX_EDGE 就等比缩到 MAX_EDGE
 *   2. 转成 JPEG，质量从 0.82 起，还超 TARGET_BYTES 就逐档降到 0.6
 *   3. 还超就把长边降到 1280 再来一轮
 *   4. 压完反而比原图大（本来就是小图），就用原图
 *
 * 任何一步失败都退回「原图直接转 base64」，保证功能不会因为压缩而挂掉。
 */

export type UploadImage = {
  fileName: string;
  mime: string;
  /** 不带 data:image/xxx;base64, 前缀的纯 base64 */
  base64: string;
};

/** 缩放后的长边上限（收货凭证、产品图这个尺寸足够看清） */
const MAX_EDGE = 1600;
/** 第二轮更狠的长边上限 */
const FALLBACK_EDGE = 1280;
/** 目标体积：单张压到 600KB 以内 */
const TARGET_BYTES = 600 * 1024;
/** 依次尝试的 JPEG 质量 */
const QUALITY_STEPS = [0.82, 0.7, 0.6];

/** 动图压了会变成一张静态图，跳过不压 */
const SKIP_COMPRESS_MIME = new Set(["image/gif"]);

/** 把 Blob/File 读成不带前缀的 base64 */
function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const result = fr.result;
      if (typeof result !== "string") {
        reject(new Error("文件读取失败"));
        return;
      }
      resolve(result.split(",")[1] ?? "");
    };
    fr.onerror = () => reject(new Error("文件读取失败"));
    fr.readAsDataURL(blob);
  });
}

/**
 * 解码成可以画到 canvas 上的图。
 * 优先 createImageBitmap 并让它按 EXIF 摆正方向 —— 手机竖着拍的照片带旋转信息，
 * 不摆正的话画到 canvas 上会横过来。
 */
async function decodeImage(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // 老浏览器不认 imageOrientation 选项，往下走 <img> 那条路
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败"));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** 按长边上限画到 canvas，导出成 JPEG Blob */
function drawToJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxEdge: number,
  quality: number,
): Promise<Blob | null> {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  // JPEG 不支持透明，PNG 的透明区域不铺底会变黑
  // ⚠️ 这里**必须写死颜色，不能用 var(--white)**：
  // fillStyle 是 canvas 的 JS 接口，不是 CSS，塞 var() 进去浏览器认不出、整句被忽略，
  // 底色就退回默认的黑色 —— 带透明背景的 PNG 压完会变成黑底。
  // （2026-08-09 批量换色时真的被换成 var(--white) 过，部署前查出来的。）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);

  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), "image/jpeg", quality);
  });
}

/** 把文件名的扩展名换成 .jpg（压缩后统一是 JPEG） */
function toJpegFileName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, "");
  return `${base || "image"}.jpg`;
}

/**
 * 上传前压缩。压不动或压不了就原样返回，绝不因为压缩失败而阻断上传。
 */
export async function compressImageForUpload(file: File): Promise<UploadImage> {
  const originalMime = file.type || "image/jpeg";
  const fallback = async (): Promise<UploadImage> => ({
    fileName: file.name,
    mime: originalMime,
    base64: await readAsBase64(file),
  });

  if (!originalMime.startsWith("image/") || SKIP_COMPRESS_MIME.has(originalMime)) {
    return fallback();
  }

  let decoded: Awaited<ReturnType<typeof decodeImage>> | null = null;
  try {
    decoded = await decodeImage(file);
    let best: Blob | null = null;
    for (const maxEdge of [MAX_EDGE, FALLBACK_EDGE]) {
      for (const quality of QUALITY_STEPS) {
        const blob = await drawToJpeg(decoded.source, decoded.width, decoded.height, maxEdge, quality);
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= TARGET_BYTES) {
          best = blob;
          break;
        }
      }
      if (best && best.size <= TARGET_BYTES) break;
    }
    // 压完没变小（原本就是小图/已经压过），用原图更划算
    if (!best || best.size >= file.size) return fallback();
    return {
      fileName: toJpegFileName(file.name),
      mime: "image/jpeg",
      base64: await readAsBase64(best),
    };
  } catch {
    return fallback();
  } finally {
    decoded?.release();
  }
}

/** 估算这段 base64 实际会占多少字节的请求体 */
export function base64Bytes(base64: string): number {
  return Math.ceil(base64.length * 0.75);
}

/** 给用户看的体积文字，如 “1.2MB” / “480KB” */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
