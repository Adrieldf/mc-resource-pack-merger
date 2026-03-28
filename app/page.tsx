"use client";

import { useState, useRef } from "react";
import JSZip from "jszip";

export default function Home() {
  const [packs, setPacks] = useState<File[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "Merged_Resource_Pack.zip";
      link.click();
      URL.revokeObjectURL(link.href);

      log("Success! Download initiated.");
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

        <button
          onClick={mergePacks}
          disabled={isMerging || packs.length < 2}
          className={`mc-button mc-button-success w-full py-4 text-lg mt-4 ${isMerging ? 'animate-pulse' : ''}`}
        >
          {isMerging ? "Merging..." : "Merge Packs"}
        </button>

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
    </main>
  );
}