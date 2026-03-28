"use client";

import { useState, useRef, useEffect } from "react";
import JSZip from "jszip";

export default function Home() {
  const [packs, setPacks] = useState<File[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const [mergedPackUrl, setMergedPackUrl] = useState<string | null>(null);
  const [previewImages, setPreviewImages] = useState<{path: string, url: string}[]>([]);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    try {
      const mergedZip = new JSZip();
      const jsonStore = new Map<string, any>();

      // Process lowest priority first so higher priority naturally overwrites
      const reversed = [...packs].reverse();

      for (const file of reversed) {
        log(`Extracting: ${file.name}...`);
        const zip = await JSZip.loadAsync(file);

        const promises: Promise<void>[] = [];

        zip.forEach((relativePath, zipEntry) => {
          if (zipEntry.dir) return;

          const isAtlas = relativePath.startsWith("assets/minecraft/atlases/") && relativePath.endsWith(".json");
          const isFont = relativePath.startsWith("assets/minecraft/font/") && relativePath.endsWith(".json");
          const isSounds = relativePath === "assets/minecraft/sounds.json";
          const isMeta = relativePath === "pack.mcmeta";

          if (isAtlas || isFont || isSounds || isMeta) {
            promises.push(
              zipEntry.async("string").then((text) => {
                try {
                  const parsed = JSON.parse(text);

                  if (isAtlas) {
                    const current = jsonStore.get(relativePath) || { sources: [] };
                    if (parsed.sources) current.sources.push(...parsed.sources);
                    jsonStore.set(relativePath, current);
                  }
                  else if (isFont) {
                    const current = jsonStore.get(relativePath) || { providers: [] };
                    if (parsed.providers) current.providers.push(...parsed.providers);
                    jsonStore.set(relativePath, current);
                  }
                  else if (isSounds) {
                    const current = jsonStore.get(relativePath) || {};
                    Object.assign(current, parsed); // Higher priority overwrites conflicting sound events
                    jsonStore.set(relativePath, current);
                  }
                  else if (isMeta) {
                    const current = jsonStore.get(relativePath);
                    if (!current) {
                      jsonStore.set(relativePath, parsed);
                    } else {
                      const curFormat = current.pack?.pack_format || 0;
                      const newFormat = parsed.pack?.pack_format || 0;
                      if (newFormat > curFormat) current.pack.pack_format = newFormat;
                      if (parsed.pack?.description) current.pack.description = parsed.pack.description;
                      jsonStore.set(relativePath, current);
                    }
                  }
                } catch (e) {
                  log(`Warning: Malformed JSON ignored in ${relativePath}`);
                }
              })
            );
          } else {
            // Standard files (textures, models) overwrite entirely
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

      log("Extracting preview images...");
      const images: {path: string, url: string}[] = [];
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

  return (
    <main className="max-w-3xl mx-auto p-4 md:p-8 min-h-screen flex flex-col items-center justify-center">
      <div className="mc-panel w-full p-6 md:p-10 flex flex-col gap-6 shadow-2xl">
        <div className="text-center">
          <h1 className="mc-text text-2xl md:text-3xl lg:text-4xl text-[#3b3b3b] drop-shadow-sm mb-2">Resource Pack</h1>
          <h2 className="mc-text text-xl md:text-2xl text-[#3b3b3b] drop-shadow-sm">Merger</h2>
          <div className="h-1 w-full bg-[#555] mt-4 border-b-2 border-white opacity-50"></div>
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
            
            <a 
              href={mergedPackUrl} 
              download="Merged_Resource_Pack.zip"
              className="mc-button mc-button-success w-full py-4 text-lg text-center block"
            >
              📥 Download Pack
            </a>

            <div className="flex items-center justify-between">
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
                      + <br/> {previewImages.length - 100} <br/> more
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