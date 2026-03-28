"use client";

import { useState, useRef, useEffect } from "react";
import JSZip from "jszip";
import { Dropbox } from "dropbox";
import "isomorphic-fetch";

export default function Home() {
  const [packs, setPacks] = useState<File[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const [mergedPackUrl, setMergedPackUrl] = useState<string | null>(null);
  const [previewImages, setPreviewImages] = useState<{ path: string, url: string }[]>([]);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [dropboxUrl, setDropboxUrl] = useState<string | null>(null);
  const [packSha1, setPackSha1] = useState<string | null>(null);
  const [packName, setPackName] = useState("Merged_Resource_Pack");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle Dropbox Redirect Callback
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");

    if (code) {
      log("Dropbox authorization detected. Exchanging code...");
      exchangeDropboxCode(code);
    }
  }, []);

  // Exchange Code for Token and Upload
  const exchangeDropboxCode = async (code: string) => {
    setIsUploading(true);
    try {
      const dbx = new Dropbox({ clientId: process.env.NEXT_PUBLIC_DROPBOX_APP_KEY || "YOUR_DROPBOX_APP_KEY" });
      const verifier = sessionStorage.getItem("dropbox_code_verifier");

      if (!verifier) throw new Error("Missing code verifier. Please try again.");

      const authRes = await dbx.auth.getAccessTokenFromCode(window.location.origin + window.location.pathname, code);
      const accessToken = (authRes.result as any).access_token;

      // Clean the URL (remove query params)
      window.history.replaceState({}, document.title, window.location.pathname);

      // Now we need the file! We can't keep blobs across redirects, 
      // so we have to use the sessionStorage trick or just tell user to click publish again.
      // Better: In a real app we'd store the file in IndexedDB, but for now let's just 
      // see if the blob URL still works (it won't).
      // Solution: We'll store the binary string in sessionStorage if it's small, 
      // but resource packs are big.
      // Better Solution: We will NOT redirect if we have a valid token.

      log("Login successful! Requesting upload...");
      // For this workflow, the redirect breaks the React state. 
      // I'll refactor handlePublishToDropbox to handle the whole flow.
    } catch (err: any) {
      log(`Dropbox Auth Error: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Cleanup object URLs on unmount to avert memory leaks
  useEffect(() => {
    return () => {
      if (mergedPackUrl) URL.revokeObjectURL(mergedPackUrl);
      previewImages.forEach(img => URL.revokeObjectURL(img.url));
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setPacks(Array.from(e.target.files));
    }
  };

  const movePack = (index: number, direction: number) => {
    const newPacks = [...packs];
    const temp = newPacks[index];
    newPacks[index] = newPacks[index + direction];
    newPacks[index + direction] = temp;
    setPacks(newPacks);
  };

  const removePack = (index: number) => {
    const newPacks = [...packs];
    newPacks.splice(index, 1);
    setPacks(newPacks);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const log = (msg: string) => {
    setLogs((prev) => [...prev, msg]);
  };

  const mergePacks = async () => {
    if (packs.length < 2) return alert("Select at least 2 packs.");

    setIsMerging(true);
    setLogs([]);
    setMergedPackUrl(null);
    setPreviewImages([]);
    setIsPreviewModalOpen(false);
    setDropboxUrl(null);
    setPackSha1(null);

    try {
      const mergedZip = new JSZip();
      const jsonStore = new Map<string, any>();

      // Process lowest priority first so higher priority naturally overwrites
      const reversed = [...packs].reverse();

      for (const file of reversed) {
        log(`Extracting: ${file.name}...`);
        const zip = await JSZip.loadAsync(file);

        // Detect if the zip has a single root folder wrapping everything
        const entries = Object.keys(zip.files).filter(k => !zip.files[k].dir);
        let commonPrefix = "";
        if (entries.length > 0) {
          const firstParts = entries[0].split('/');
          if (firstParts.length > 1) {
            const potentialRoot = firstParts[0] + '/';
            if (entries.every(e => e.startsWith(potentialRoot))) {
              commonPrefix = potentialRoot;
              log(`Note: Stripping root folder "${potentialRoot}" from ${file.name}`);
            }
          }
        }

        const promises: Promise<void>[] = [];

        zip.forEach((originalPath, zipEntry) => {
          if (zipEntry.dir) return;

          // Strip the common root prefix if it exists
          let relativePath = originalPath;
          if (commonPrefix && relativePath.startsWith(commonPrefix)) {
            relativePath = relativePath.substring(commonPrefix.length);
          }

          // Ignore junk files
          if (relativePath.startsWith("__MACOSX/") || relativePath.includes(".DS_Store") || relativePath.endsWith("desktop.ini")) {
            return;
          }

          const pathParts = relativePath.split('/');
          const isUnderAssets = pathParts[0] === 'assets';

          const isAtlas = isUnderAssets && pathParts[2] === 'atlases' && relativePath.endsWith(".json");
          const isFont = isUnderAssets && pathParts[2] === 'font' && relativePath.endsWith(".json");
          const isSounds = isUnderAssets && pathParts[2] === 'sounds.json';
          const isItemModel = isUnderAssets && pathParts[2] === 'models' && pathParts[3] === 'item' && relativePath.endsWith(".json");
          const isMeta = relativePath === "pack.mcmeta";
          const isPackIcon = relativePath === "pack.png";

          // Special logic: only take pack.mcmeta and pack.png from the HIGHEST priority pack (last in reversed loop)
          const isHighestPriority = file === reversed[reversed.length - 1];
          if ((isMeta || isPackIcon) && !isHighestPriority) {
            log(`Ignoring redundant ${relativePath} from lower priority pack: ${file.name}`);
            return;
          }

          if (isAtlas || isFont || isSounds || isMeta || isItemModel) {
            promises.push(
              zipEntry.async("string").then((text) => {
                try {
                  const parsed = JSON.parse(text);

                  if (isAtlas) {
                    const current = jsonStore.get(relativePath) || { sources: [] };
                    if (parsed.sources) current.sources.unshift(...parsed.sources);
                    jsonStore.set(relativePath, current);
                  }
                  else if (isFont) {
                    const current = jsonStore.get(relativePath) || { providers: [] };
                    if (parsed.providers) current.providers.unshift(...parsed.providers);
                    jsonStore.set(relativePath, current);
                  }
                  else if (isSounds) {
                    const current = jsonStore.get(relativePath) || {};
                    Object.assign(current, parsed);
                    jsonStore.set(relativePath, current);
                  }
                  else if (isItemModel) {
                    const current = jsonStore.get(relativePath) || parsed;
                    if (current !== parsed && parsed.overrides) {
                      if (!current.overrides) current.overrides = [];
                      current.overrides.unshift(...parsed.overrides);
                    }
                    jsonStore.set(relativePath, current);
                  }
                  else if (isMeta) {
                    // Since we already filtered for highest priority above, we just set it.
                    jsonStore.set(relativePath, parsed);
                  }
                } catch (e) {
                  log(`Warning: Malformed JSON ignored in ${relativePath}`);
                }
              })
            );
          } else {
            // Standard files (textures, models, icons) overwrite entirely
            promises.push(
              zipEntry.async("uint8array").then((data) => {
                mergedZip.file(relativePath, data);
              })
            );
          }
        });

        await Promise.all(promises);
      }

      log("Applying JSON merges...");
      jsonStore.forEach((data, path) => {
        mergedZip.file(path, JSON.stringify(data, null, 2));
      });

      log("Compressing final merged pack...");
      const blob = await mergedZip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const blobUrl = URL.createObjectURL(blob);

      log("Calculating SHA-1 hash...");
      const arrayBuffer = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-1", arrayBuffer);
      const sha1 = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      setPackSha1(sha1);

      log("Extracting preview images...");
      const images: { path: string, url: string }[] = [];
      const imgPromises: Promise<void>[] = [];
      mergedZip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir && relativePath.endsWith(".png")) {
          imgPromises.push(
            zipEntry.async("blob").then((imgBlob) => {
              images.push({
                path: relativePath,
                url: URL.createObjectURL(imgBlob),
              });
            })
          );
        }
      });
      await Promise.all(imgPromises);

      // Sort images by path for consistency
      images.sort((a, b) => a.path.localeCompare(b.path));

      setPreviewImages(images);
      setMergedPackUrl(blobUrl);

      log("Success! Ready for preview and download.");
    } catch (err: any) {
      log(`Critical Error: ${err.message}`);
    } finally {
      setIsMerging(false);
    }
  };

  const uploadToDropbox = async (accessToken: string) => {
    setIsUploading(true);
    setDropboxUrl(null);
    log("Uploading to Dropbox...");
    try {
      if (!mergedPackUrl) throw new Error("No merged pack found");
      const blob = await fetch(mergedPackUrl).then((r) => r.blob());

      const dbx = new Dropbox({ accessToken });
      const path = `/${safePackName}.zip`;

      log(`Uploading ${path}...`);
      await dbx.filesUpload({
        path,
        contents: blob,
        mode: { ".tag": "overwrite" }
      });

      log("Creating shared link...");
      const linkRes = await dbx.sharingCreateSharedLinkWithSettings({
        path,
        settings: { requested_visibility: { ".tag": "public" } }
      });

      // Dropbox direct link trick: change dl=0 to dl=1
      const directUrl = linkRes.result.url.replace("?dl=0", "?dl=1");
      setDropboxUrl(directUrl);
      log(`Success! Dropbox Link generated.`);
    } catch (err: any) {
      // If link already exists, try to list shared links
      if (err.status === 409) {
        try {
          const dbx = new Dropbox({ accessToken });
          const listRes = await dbx.sharingListSharedLinks({ path: `/${safePackName}.zip` });
          if (listRes.result.links.length > 0) {
            const directUrl = listRes.result.links[0].url.replace("?dl=0", "?dl=1");
            setDropboxUrl(directUrl);
            log(`Retrieved existing link from Dropbox.`);
            return;
          }
        } catch (e) { }
      }
      log(`Dropbox Error: ${err.message || 'Check your App Key and Scopes'}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handlePublishToDropbox = async () => {
    const appKey = process.env.NEXT_PUBLIC_DROPBOX_APP_KEY || "YOUR_DROPBOX_APP_KEY";
    if (!appKey || appKey === "YOUR_DROPBOX_APP_KEY") {
      return alert("Missing Dropbox App Key. Please configure NEXT_PUBLIC_DROPBOX_APP_KEY in your .env.local file.");
    }

    // Check if we already have a code in the URL (returning from redirect)
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");

    if (!code) {
      log("Opening Dropbox authorization popup...");
      const dbx = new Dropbox({ clientId: appKey });
      const redirectUri = window.location.origin + window.location.pathname.replace(/\/$/, '') + '/dropbox-callback.html';
      const authUrl = await dbx.auth.getAuthenticationUrl(
        redirectUri,
        undefined,
        'code',
        'offline',
        undefined,
        'none',
        true
      );

      const popup = window.open(authUrl.toString(), "Dropbox Auth", "width=600,height=700");

      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'dropbox_auth_code') {
          window.removeEventListener('message', handleMessage);
          const tokenRes = await dbx.auth.getAccessTokenFromCode(redirectUri, event.data.code);
          uploadToDropbox((tokenRes.result as any).access_token);
        }
      };
      window.addEventListener('message', handleMessage);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    log(`Copied ${label} to clipboard!`);
  };

  const safePackName = packName.trim().replace(/[^a-z0-9_\-]/gi, '_') || "Merged_Resource_Pack";

  return (
    <main className="max-w-3xl mx-auto p-4 md:p-8 min-h-screen flex flex-col items-center justify-center">
      <div className="mc-panel w-full p-6 md:p-10 flex flex-col gap-6 shadow-2xl">
        <div className="text-center relative">
          <h1 className="mc-text text-2xl md:text-3xl lg:text-4xl text-[#3b3b3b] drop-shadow-sm mb-2">Resource Pack</h1>
          <h2 className="mc-text text-xl md:text-2xl text-[#3b3b3b] drop-shadow-sm">Merger</h2>
          <span className="absolute top-0 right-0 mc-item px-2 py-1 text-[8px] sm:text-[10px] transform translate-x-2 -translate-y-2">v1.2</span>
          <div className="h-1 w-full bg-[#555] mt-4 border-b-2 border-white opacity-50"></div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="mc-label text-sm uppercase tracking-wide">Pack Output Name</label>
          <input
            type="text"
            value={packName}
            onChange={(e) => setPackName(e.target.value)}
            className="mc-item w-full p-4 bg-[#1a1a1a] border-4 border-[#000] focus:border-yellow-400 outline-none font-sans font-bold"
            placeholder="Name your pack..."
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="mc-label text-sm uppercase tracking-wide">Add Resource Packs (.zip)</label>
          <div className="relative">
            <input
              type="file"
              multiple
              accept=".zip"
              onChange={handleFileChange}
              ref={fileInputRef}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
            />
            <div className="mc-button w-full py-4 text-center">
              Choose Files
            </div>
          </div>
        </div>

        {packs.length > 0 && (
          <div className="flex flex-col gap-3 mt-2">
            <strong className="mc-label text-sm">Priority List (Top = Overwrites Bottom):</strong>
            <div className="bg-[#1a1a1a] border-4 border-[#000] p-2 h-64 overflow-y-auto space-y-2 relative" style={{ boxShadow: "inset 4px 4px 0px 0px #0a0a0a, inset -4px -4px 0px 0px #333333" }}>
              {packs.map((file, index) => (
                <div key={`${file.name}-${index}`} className="mc-item flex flex-col sm:flex-row justify-between items-start sm:items-center p-3">
                  <span className="truncate font-sans font-bold w-full sm:w-2/3 mb-2 sm:mb-0">
                    <span className="mc-text text-yellow-300 mr-2">{index + 1}.</span> {file.name}
                  </span>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => movePack(index, -1)} disabled={index === 0} className="mc-button px-3 py-2 text-xs" title="Move Up">▲</button>
                    <button onClick={() => movePack(index, 1)} disabled={index === packs.length - 1} className="mc-button px-3 py-2 text-xs" title="Move Down">▼</button>
                    <button onClick={() => removePack(index)} className="mc-button mc-button-danger px-3 py-2 text-xs" title="Remove">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!mergedPackUrl && (
          <button
            onClick={mergePacks}
            disabled={isMerging || packs.length < 2}
            className={`mc-button mc-button-success w-full py-4 text-lg mt-4 ${isMerging ? 'animate-pulse' : ''}`}
          >
            {isMerging ? "Merging..." : "Merge Packs"}
          </button>
        )}

        {mergedPackUrl && (
          <div className="flex flex-col gap-4 mt-4 border-t-4 border-[#333] pt-6">
            <h3 className="mc-text text-xl text-center text-[#3b3b3b]">Ready to Download</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <a
                href={mergedPackUrl}
                download={`${safePackName}.zip`}
                className="mc-button mc-button-success py-4 text-base sm:text-lg text-center block w-full"
              >
                📥 Download
              </a>

              <button
                onClick={handlePublishToDropbox}
                disabled={isUploading}
                className={`mc-button py-4 text-base sm:text-lg w-full ${isUploading ? 'animate-pulse opacity-50' : ''}`}
              >
                📦 {isUploading ? "Uploading..." : "Publish to Dropbox"}
              </button>
            </div>

            {dropboxUrl && (
              <div className="mc-item p-4 border-2 border-blue-400 !bg-blue-900 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <span className="block font-bold font-sans text-blue-200 text-xs text-center">Direct Download (dl=1):</span>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={dropboxUrl}
                      className="mc-item flex-1 bg-black/30 border-2 border-blue-800 p-2 text-[10px] text-white truncate font-mono"
                    />
                    <button
                      onClick={() => copyToClipboard(dropboxUrl, "Download URL")}
                      className="mc-button px-3 py-1 text-[10px]"
                      title="Copy URL"
                    >
                      📋
                    </button>
                  </div>
                </div>

                {packSha1 && (
                  <div className="border-t border-blue-400/30 pt-4 flex flex-col gap-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* SHA-1 Section */}
                      <div className="flex flex-col gap-2">
                        <span className="block font-bold font-sans text-blue-200 text-[10px]">resource-pack-sha1:</span>
                        <div className="flex gap-2">
                          <input
                            readOnly
                            value={packSha1}
                            className="mc-item flex-1 bg-black/30 border-2 border-blue-800 p-2 text-[10px] text-green-400 truncate font-mono"
                          />
                          <button
                            onClick={() => copyToClipboard(packSha1, "SHA-1")}
                            className="mc-button px-3 py-1 text-[10px]"
                          >
                            📋
                          </button>
                        </div>
                      </div>

                      {/* Escaped URL for server.properties */}
                      <div className="flex flex-col gap-2">
                        <span className="block font-bold font-sans text-blue-200 text-[10px]">resource-pack (escaped):</span>
                        <div className="flex gap-2">
                          <input
                            readOnly
                            value={dropboxUrl.replace(/=/g, "\\=").replace(/:/g, "\\:")}
                            className="mc-item flex-1 bg-black/30 border-2 border-blue-800 p-2 text-[10px] text-yellow-300 truncate font-mono"
                          />
                          <button
                            onClick={() => copyToClipboard(dropboxUrl.replace(/=/g, "\\=").replace(/:/g, "\\:"), "Escaped URL")}
                            className="mc-button px-3 py-1 text-[10px]"
                          >
                            📋
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="bg-black/40 p-3 border border-blue-500/30 rounded text-center">
                      <p className="text-[9px] text-blue-100 font-sans leading-relaxed">
                        Tip: Dropbox links with <code>dl=1</code> work perfectly with Minecraft Servers as they bypass all confirmation pages.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between mt-2">
              <strong className="mc-label text-sm mt-2">Texture Preview ({previewImages.length} items):</strong>
              <div className="flex gap-2">
                {previewImages.length > 0 && (
                  <button
                    onClick={() => setIsPreviewModalOpen(true)}
                    className="mc-button px-4 py-2 text-xs bg-[#555] text-white"
                  >
                    🔍 View All
                  </button>
                )}
                <button
                  onClick={() => { setMergedPackUrl(null); setPreviewImages([]); }}
                  className="mc-button mc-button-danger px-4 py-2 text-xs"
                >
                  Clear
                </button>
              </div>
            </div>

            {previewImages.length > 0 ? (
              <div className="bg-[#1a1a1a] border-4 border-[#000] p-4 h-80 overflow-y-auto" style={{ boxShadow: "inset 4px 4px 0px 0px #0a0a0a, inset -4px -4px 0px 0px #333333" }}>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4 justify-items-center">
                  {previewImages.slice(0, 100).map((img, i) => (
                    <div key={i} className="mc-item w-20 h-20 p-2 flex flex-col items-center justify-center relative group" title={img.path}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={img.path} className="max-w-full max-h-full object-contain" style={{ imageRendering: "pixelated" }} />
                      <div className="hidden group-hover:block absolute bottom-0 left-0 bg-black/80 text-white text-[10px] p-1 w-full truncate text-center z-10 font-sans">
                        {img.path.split('/').pop()}
                      </div>
                    </div>
                  ))}
                  {previewImages.length > 100 && (
                    <div className="mc-item w-20 h-20 flex items-center justify-center p-2 text-center text-xs leading-none">
                      + <br /> {previewImages.length - 100} <br /> more
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="mc-item p-4 text-center text-sm font-sans mx-auto w-full">
                No .png textures found in the selected packs.
              </div>
            )}
          </div>
        )}

        {logs.length > 0 && (
          <div className="mt-4 p-4 bg-black border-4 border-[#333] shadow-inner relative">
            <h3 className="mc-text text-green-400 text-xs mb-2">Logs:</h3>
            <div className="font-sans font-mono text-sm text-gray-300 h-32 overflow-y-auto whitespace-pre-wrap">
              {logs.map((log, i) => (
                <div key={i}>{'>'} {log}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Full Screen Preview Modal */}
      {isPreviewModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 sm:p-8 backdrop-blur-sm">
          <div className="mc-panel w-full h-[90vh] sm:h-full max-w-7xl flex flex-col shadow-[0_0_50px_rgba(0,0,0,1)]">
            <div className="flex justify-between items-center mb-4 pb-4 border-b-4 border-[#555]">
              <h2 className="mc-text text-xl md:text-2xl text-[#333]">All Textures ({previewImages.length})</h2>
              <button
                onClick={() => setIsPreviewModalOpen(false)}
                className="mc-button mc-button-danger px-4 py-2 text-lg font-bold"
              >
                ✕ Close
              </button>
            </div>

            <div className="flex-1 bg-[#1a1a1a] border-4 border-[#000] p-4 overflow-y-auto" style={{ boxShadow: "inset 4px 4px 0px 0px #0a0a0a, inset -4px -4px 0px 0px #333333" }}>
              <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-4 justify-items-center">
                {previewImages.map((img, i) => (
                  <div key={i} className="mc-item w-full aspect-square p-2 flex flex-col items-center justify-center relative group" title={img.path}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.path}
                      loading="lazy"
                      className="max-w-full max-h-full object-contain"
                      style={{ imageRendering: "pixelated" }}
                    />
                    <div className="hidden group-hover:block absolute bottom-0 left-0 bg-black/90 text-white text-[10px] p-2 w-full text-center z-10 font-sans break-words whitespace-normal leading-tight h-auto max-h-full overflow-hidden">
                      {img.path.split('/').pop()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}