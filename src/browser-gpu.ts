/** Hardware is the default; software evidence must be explicitly requested. */
export function browserGpuArgs(
  backend: "webgl" | "webgpu" = "webgl",
  selection?: string,
  platform: string = process.platform
): string[] {
  const gpu = selection ?? "hardware";
  if (gpu !== "hardware" && gpu !== "software") {
    throw new Error("SCENEPROOF_GPU must be hardware or software.");
  }
  if (gpu === "software") {
    return backend === "webgpu" && platform === "linux"
      ? [
          "--disable-vulkan-surface",
          "--enable-accelerated-2d-canvas",
          "--enable-features=Vulkan",
          "--enable-unsafe-webgpu",
          "--use-angle=vulkan",
          "--use-gpu-in-tests",
          "--use-vulkan=swiftshader",
          "--use-webgpu-adapter=swiftshader",
        ]
      : ["--use-angle=swiftshader"];
  }
  if (platform !== "linux") {
    return backend === "webgpu" ? ["--enable-unsafe-webgpu"] : [];
  }
  return [
    "--disable-vulkan-surface",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--use-angle=vulkan",
    "--use-gpu-in-tests",
  ];
}
