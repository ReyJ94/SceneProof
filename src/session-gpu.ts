/** Installed before source load. Timestamp instrumentation is opt-in and inactive in CPU windows. */
export function installGpuTimings(): void {
  // WebGPU's standard buffer-usage bit values; this code executes in the page.
  const usage = {
    copyDestination: 0x8,
    copySource: 0x4,
    mapRead: 0x1,
    queryResolve: 0x2_00,
  };
  type Slot = {
    query: GPUQuerySet;
    resolve: GPUBuffer;
    read: GPUBuffer;
    submitted: boolean;
  };
  type Device = {
    device: GPUDevice;
    adapter: Record<string, unknown>;
    available: Slot[];
    slots: Set<Slot>;
  };
  type Sample = {
    device: number;
    pass: string;
    kind: "render" | "compute";
    milliseconds: number;
    adapter: Record<string, unknown>;
    sampleCount: number | null;
    frame: unknown;
  };
  let active = false;
  const devices: Device[] = [];
  const pending = new Set<Promise<void>>();
  const limitations: string[] = [];
  const errors: string[] = [];
  const viewSampleCounts = new WeakMap<GPUTextureView, number>();
  if (typeof GPUTexture !== "undefined") {
    const { createView } = GPUTexture.prototype;
    GPUTexture.prototype.createView = function (descriptor) {
      const view = createView.call(this, descriptor);
      viewSampleCounts.set(view, this.sampleCount);
      return view;
    };
  }
  const commands = new WeakMap<
    GPUCommandBuffer,
    Array<{ slot: Slot; sample: Omit<Sample, "milliseconds"> }>
  >();
  const api = {
    dispose() {
      for (const owner of devices) {
        for (const slot of owner.slots) {
          slot.query.destroy();
          slot.resolve.destroy();
          slot.read.destroy();
        }
      }
    },
    async flush() {
      while (pending.size) {
        // biome-ignore lint/performance/noAwaitInLoops: Drain newly submitted timestamp reads before ending this diagnostic window.
        await Promise.all([...pending]);
      }
    },
    start() {
      if (active) {
        throw new Error("GPU timing window already active.");
      }
      active = true;
    },
    status() {
      return {
        enabled: active,
        errors: [...errors],
        limitations: [...new Set(limitations)],
        supportedDevices: devices.length,
        unsubmittedPasses: devices.reduce(
          (sum, owner) =>
            sum +
            [...owner.slots].filter(
              (slot) => !(slot.submitted || owner.available.includes(slot))
            ).length,
          0
        ),
      };
    },
    stop() {
      active = false;
    },
  };
  Reflect.set(globalThis, "__SCENEPROOF_GPU_TIMINGS__", api);
  if (typeof GPUAdapter === "undefined") {
    limitations.push("WebGPU API unavailable");
    return;
  }
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (deviceDescriptor = {}) {
    const features = new Set(deviceDescriptor.requiredFeatures ?? []);
    if (this.features.has("timestamp-query")) {
      features.add("timestamp-query");
    }
    const device = await request.call(this, {
      ...deviceDescriptor,
      requiredFeatures: [...features],
    });
    if (!device.features.has("timestamp-query")) {
      limitations.push("Device does not support timestamp-query");
      return device;
    }
    const adapter = {
      architecture: this.info.architecture,
      description: this.info.description,
      device: this.info.device,
      isFallbackAdapter: this.info.isFallbackAdapter,
      vendor: this.info.vendor,
    };
    const deviceIndex = devices.length;
    const owner: Device = { adapter, available: [], device, slots: new Set() };
    devices.push(owner);
    function acquire(): Slot {
      const reused = owner.available.pop();
      if (reused) {
        reused.submitted = false;
        return reused;
      }
      const slot = {
        query: device.createQuerySet({ count: 2, type: "timestamp" }),
        read: device.createBuffer({
          size: 16,
          usage: usage.copyDestination + usage.mapRead,
        }),
        resolve: device.createBuffer({
          size: 16,
          usage: usage.queryResolve + usage.copySource,
        }),
        submitted: false,
      };
      owner.slots.add(slot);
      return slot;
    }
    const create = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (encoderDescriptor) => {
      const encoder = create(encoderDescriptor);
      const records: Array<{
        slot: Slot;
        sample: Omit<Sample, "milliseconds">;
      }> = [];
      const render = encoder.beginRenderPass.bind(encoder);
      const compute = encoder.beginComputePass.bind(encoder);
      function writes(
        passDescriptor: GPURenderPassDescriptor | GPUComputePassDescriptor,
        kind: "render" | "compute"
      ) {
        if (!active) {
          return passDescriptor;
        }
        if (passDescriptor.timestampWrites) {
          limitations.push(
            "Owner-supplied timestampWrites retained; that pass is not collected by SceneProof"
          );
          return passDescriptor;
        }
        const slot = acquire();
        const attachment =
          "colorAttachments" in passDescriptor
            ? (Array.from(passDescriptor.colorAttachments).find(
                (value) => value !== null
              )?.view ?? passDescriptor.depthStencilAttachment?.view)
            : undefined;
        records.push({
          sample: {
            adapter,
            device: deviceIndex,
            frame:
              Reflect.get(globalThis, "__SCENEPROOF_FRAME_CONTEXT__") ?? null,
            kind,
            pass: passDescriptor.label ?? "unlabeled",
            sampleCount: attachment
              ? (viewSampleCounts.get(attachment) ?? null)
              : null,
          },
          slot,
        });
        return {
          ...passDescriptor,
          timestampWrites: {
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1,
            querySet: slot.query,
          },
        };
      }
      encoder.beginRenderPass = (renderDescriptor) =>
        render(writes(renderDescriptor, "render") as GPURenderPassDescriptor);
      encoder.beginComputePass = (computeDescriptor = {}) =>
        compute(writes(computeDescriptor, "compute"));
      const finish = encoder.finish.bind(encoder);
      encoder.finish = (finishDescriptor) => {
        for (const { slot } of records) {
          encoder.resolveQuerySet(slot.query, 0, 2, slot.resolve, 0);
          encoder.copyBufferToBuffer(slot.resolve, 0, slot.read, 0, 16);
        }
        const command = finish(finishDescriptor);
        commands.set(command, records);
        return command;
      };
      return encoder;
    };
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (input) => {
      const list = [...input];
      submit(list);
      for (const command of list) {
        for (const { slot, sample } of commands.get(command) ?? []) {
          slot.submitted = true;
          const read = slot.read
            .mapAsync(0x1)
            .then(async () => {
              const values = new BigUint64Array(slot.read.getMappedRange());
              const [begin, end] = values;
              if (begin === undefined || end === undefined || end < begin) {
                throw new Error("GPU timestamp order is invalid.");
              }
              const milliseconds = Number(end - begin) / 1_000_000;
              slot.read.unmap();
              const sink = Reflect.get(
                globalThis,
                "__SCENEPROOF_TIMESTAMP_SINK__"
              );
              if (typeof sink !== "function") {
                throw new Error("GPU timestamp evidence sink is unavailable.");
              }
              await sink({ ...sample, milliseconds });
              owner.available.push(slot);
            })
            .catch((error) => {
              errors.push(String(error));
            })
            .finally(() => {
              pending.delete(read);
            });
          pending.add(read);
        }
      }
    };
    return device;
  };
}

export type GpuPassSummary = {
  count: number;
  minimumMs: number;
  maximumMs: number;
  meanMs: number;
};
export function addGpuSample(
  previous: GpuPassSummary | undefined,
  milliseconds: number
): GpuPassSummary {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("GPU time must be a nonnegative finite duration.");
  }
  if (!previous) {
    return {
      count: 1,
      maximumMs: milliseconds,
      meanMs: milliseconds,
      minimumMs: milliseconds,
    };
  }
  const count = previous.count + 1;
  return {
    count,
    maximumMs: Math.max(previous.maximumMs, milliseconds),
    meanMs: previous.meanMs + (milliseconds - previous.meanMs) / count,
    minimumMs: Math.min(previous.minimumMs, milliseconds),
  };
}
