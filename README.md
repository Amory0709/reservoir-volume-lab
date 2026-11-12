# High-Performance 3D Visualization in the Browser

**A graphics and systems engineering lab for large, irregular 3D datasets.** Built with JavaScript, WebGL2, an experimental WebGPU backend, Web Workers, and locally parsed scientific data. The initial dataset is a geological corner-point grid; the architecture challenges also apply to CAD, digital twins, scientific visualization, and data-intensive web software.

**[Read the engineering case study →](docs/ENGINEERING_CASE_STUDY.md)** · [Detailed technical documentation (中文)](#显式角点油藏体渲染)

## At a glance

| Engineering challenge | Implemented approach |
| --- | --- |
| Responsive interaction vs expensive transparent rendering | Cached rasterized surfaces during camera interaction; full volume results when ready |
| Outdated work after user input | Latest-request GPU queue with cancellation at safe batch boundaries |
| High memory consumption | Transferable Worker buffers, compact surface indexes, shared GPU grid data and fallback paths |
| Correctness under optimization | Numerical reference comparisons, pixel regressions and recorded trade-offs |
| Backend evolution | Production WebGL2 path and explicitly experimental WebGPU compute path |

The project documents **1M / 10M / 20M synthetic grid configurations** and a supported subset of **RESQML EPC/HDF5 imports**. These are dataset scales, **not guaranteed real-time FPS**. Local software-GLES profiling reported a decrease from **577.5 ms to 421.5 ms** for one 10M-cell, 1200 × 1000 off-screen draw/readback scenario, with byte-identical output. That result is **not** a browser or discrete-GPU speed claim; see the [measurement methodology and caveats](docs/ENGINEERING_CASE_STUDY.md#4-evidence-not-headline-fps).

**Explore the engineering:** [data and worker ownership](dist/explicit-grid.js) · [GPU queue](dist/render-queue.js) · [volume rendering](dist/explicit-renderer.js) · [surface cache](dist/surface-cache.js) · [WebGPU experiment](dist/webgpu-renderer.js) · [validation](validation/)

---

# 显式角点油藏体渲染

WebGL 2 油藏显示实验，支持 **RESQML EPC + HDF5 文件导入**。默认加载 **10M 显式角点合成模型**，可切换 1M、20M 压力模型和先前的紧凑模型。支持独立孔隙度筛选、属性着色、透明体积分、真实单元边线、XYZ 剖切和本机旋转性能测试。

## 同数据的左右对比

打开 `compare.html`，左侧为体渲染，右侧为始终显示表皮的光栅渲染；默认 10M，支持 1M / 20M 和同一份 RESQML 导入。`?backend=webgpu` 使用 WebGPU，默认仍为 WebGL2。原单视图中也提供对比入口。桌面左右布局，小屏上下排列，各自控件都留在自己的区域。

- 每侧独立调整属性、孔隙度筛选、XYZ 剖切、网格线、线宽和清晰度。左侧有体密度及内部边线，右侧有表皮透明度。默认两侧均为精细档，最高 120 万像素，实际尺寸受视区和设备像素比限制。
- 相机默认同步，可关闭后单独旋转、缩放和平移。“将本侧条件应用到另一侧”复制共同的显示设置，不把体密度当作表皮透明度。
- 左侧交互时使用表皮预览，状态文字明确标注，静止后计算完整体积，完成后整幅替换；右侧始终走表皮路径。筛选与剖切更新期间保留上一幅完整画面，并显示正在更新。
- 共用一个渲染器、一份 GPU 网格纹理、一个 GPU 作业队列和一份 Worker 紧凑几何输入。两侧各有表皮索引、保留画面和设置，**总显存仍高于单视图**，但原网格纹理不重复上传。孔隙度条件相同时，Worker 复用不可变的 CPU 筛选缓存；不同时分别缓存，取消操作按侧隔离。
- GPU 顺序执行两侧工作。任意一侧的交互或设置变更可在当前小批结束后取消尚未完成的体积任务，先更新表皮，再恢复左侧完整体积。页面里的完成用时用于观察响应，不是两种方法在独占显卡下的独立性能基准。

`validate-webgpu-scheduling.mjs` 用延迟的模拟 GPU 队列执行生产比较调度器与 TypeGPU 打包器，验证六份网格纹理仅上传一次、独立缓冲/筛选/剖切、相机同步、右侧优先更新、表皮清晰度切换和释放。`validate-surface-worker.mjs` 使用真实 Worker 检查两侧独立取消与筛选范围。对比功能沿用单视图的体积与表皮着色器；尚无浏览器端到端或用户独显帧率测试。

后续性能修复继续保留两侧默认精细档（120 万像素）。alpha 使用前向累积 `A += (1-A)*a`，超过 0.997 时终止：现在完成当前格的出口边线后立即终止，不再额外查询下一格。成功沿邻接进入下一格时复用求交已读入的角点，避免重复读取八个 XYZ；经过 BVH 查询后仍重载命中的真实单元。相同尺寸的重复 resize 通知、未变化的设置不再重新计算完整体积。降低左侧体积清晰度时，其交互表皮仍保留精细上限。

数值验证：合成与 RESQML 样例共 180 组设置，在相同分辨率下优化前后的颜色逐字节一致。合成样例的着色器计数显示角点整组读取减少 18.74%，单元区间求交减少 6.44%，alpha 提前终止的射线数量不变；这不是用户显卡上的耗时加速比例。`validation/check_ray_optimization.py` 可用 `EXPLICIT_FRAGMENT` 指定不同 GLSL 版本生成对比图像。当前仍是逐单元几何求交的体渲染，其成本高于规则 Cartesian 网格的直接纹理采样；没有宣称该修复达到 200M Cartesian 的交互性能。

第二轮性能修复仍保留默认 120 万像素。WebGL / WebGPU 的单元求交共享八个角点的光线坐标投影，先拒绝不可能命中的投影包围盒，再执行原来的精确三角形测试。固定大小的三角形与边线计算在生成着色器时展开；网格线距离先比较平方值，最后才开方。原始 XYZ、筛选、剖切、alpha 积分和网格线语义不变。

调度不再把快速设备硬限在 128×128 的小块：按耗时调整到最多 65,536 像素，每帧从最多 8,192 像素重新估计，目标仍是约 8 ms 一个批次。WebGL 用可释放的 MessageChannel 任务轮询 fence，避免长串零延时 timer 的嵌套限速；长等待期间仍周期性让出时间。输入取消仍在当前批次完成后生效。对比页保留体积总耗时，并在设备支持时同时显示 GPU 耗时。

本轮实测：同一份 **10M 数据、1200×1000 像素**、默认相机 / 密度 60 / 网格线开启，在 llvmpipe 软件 GLES 环境中，预热后两次完整绘制的中位数从 **577.5 ms 降到 421.5 ms（约 27%）**；120 万像素的 RGB 逐字节一致。这是离屏着色器绘制与读取时间，未包含浏览器调度，也不是用户独显 FPS。`validation/profile_explicit.py` 接受 `EXPLICIT_FRAGMENT`、`RENDER_WIDTH`、`RENDER_HEIGHT`、`PROFILE_CASE`、`PROFILE_RUNS` 以对照不同版本。

评估但未上线：直接采用光栅表皮的首格 ID 会漏过少量亚像素前景单元；加入完整 BVH 最近命中校验后，120 万像素下没有稳定净收益，因此移除了该缓存方案。当前仍是精确逐格体渲染，没有重采样成规则体素，也没有宣称已经达到 200M Cartesian 的实时表现。

## WebGPU 实验入口

左侧“试用 WebGPU”在新引擎中重新加载当前显式模型；“返回 WebGL2”切回默认引擎。直接访问 `?backend=webgpu` 默认加载 1M，可选 10M / 20M 或导入同样范围的 RESQML；`&scale=explicit-10m` 可直接指定规模。切换会重新加载页面，文件需重新选择。不支持 WebGPU 时会明确报错并保留返回入口，不会悄悄换用 WebGL 后仍标为 WebGPU。

使用 [Software Mansion TypeGPU](https://docs.swmansion.com/TypeGPU/) 0.12.5 管理类型化 uniform 缓冲，结合原生 WebGPU 与 WGSL。依赖打包在本网站内，`npm run vendor:webgpu` 可重建，许可证位于 `dist/vendor/TYPEGPU-LICENSES.txt`。TypeGPU 仅在 WebGPU 入口动态加载，默认 WebGL 路径不加载它。

完整体积由 8×8 工作组的 compute shader 计算，逐单元 BVH / 邻接遍历、真实角点求交、属性筛选、剖切和网格线规则与 WebGL 相同。输出写入 GPU 存储纹理。表皮用实例化光栅绘制，保留 reverse-Z、透明表皮和浮点加权混合。两条路径共享一个可取消队列；每批最多 65,536 个体积像素，原生 `queue.onSubmittedWorkDone()` 等待完成，避免 JS 轮询 fence。新设置在当前小批结束后取消旧任务。

计算期间保留完整清晰表皮，全部完成后整幅替换；实验版暂不提供渐进显示。相同网格使用同样的原始纹理、分辨率档位和表面 Worker，WebGPU 不会自动减少显存或筛选计算量。`timestamp-query` 可用时显示纯 GPU 计算时间，否则明确显示计时不可用。请在相同设备、模型、视角、分辨率、密度和筛选条件下比较完整体积 FPS。未实测用户独显性能，不承诺 WebGPU 一定更快。

验证：wgpu-native 0.32.0、llvmpipe 软件适配器执行生产 WGSL，与 GLES 生产着色器进行数值对比。2,400 格合成数据与 45 格 RESQML 样例共 56 个体积设置逐像素一致；144 组表皮与 GLES 光线表面比较，平均通道差小于 0.04 / 255；40 组透明表皮覆盖透明度端点、保留网格线、剖切与逆序绘制。另验证最终采样方向、TypeGPU uniform 打包、任务取消、resize 和释放。这里不是浏览器端到端测试，也不是 10M / 20M 独显帧率验证。

可复现命令（需 Python 的 `numpy` / `wgpu==0.32.0` 和 EGL / GLES；`FIXTURE` 是 `validation/export-explicit.mjs` 或 RESQML 验证导出的几何目录）：

```sh
node validate-webgpu-scheduling.mjs
node validate-surface-cache.mjs "$CACHE" "$FIXTURE"
node validation/export-webgpu.mjs "$FIXTURE" "$OUTPUT" "$CACHE"
python validation/reference-webgpu.py "$FIXTURE" "$OUTPUT"
python validation/check_webgpu.py "$FIXTURE" "$OUTPUT" "$CACHE"
```

右上角可切换浅色 / 深色模式，首次打开跟随系统，手动选择保存在当前浏览器。主题同时更新控件、三维背景及透明表皮的背景合成，属性色标保持一致；不会重新生成网格或表面缓存。加载和性能测试期间暂时禁用手动切换。

WebGL 上下文创建后立即填入当前主题的背景，早于着色器编译、数据上传及表面缓存构建。画布保留上一帧完整图像供异步 GPU 批次等待期间显示；调整绘图缓冲尺寸后立即恢复上一帧，没有上一帧时填入主题背景，避免加载和处理时出现默认黑底。

## 清晰表面交互

显式模型加载时预先提取活动网格的外露面：保留非活动空区、断层拆点和 K 层间隙两侧的边界，删除真正共享的内部面。每个有外露面的单元只缓存一个 Uint32 编号（单元编号 × 64 + 六个面的位掩码），按外露面数量分成六组，仅绘制真实存在的面。顶点着色器直接从已有 GPU 纹理读取真实角点，片元着色器复用属性着色和原始单元边线。面内的三角剖分对角线不作为网格线。

旋转、缩放和平移使用这个表面缓存，默认不透明，最高约 200 万像素（受画布尺寸、设备像素比上限 2 限制）。停止操作后计算选定画质的完整透明体积。默认关闭“渐进显示体积”：保持清晰表皮，等完整体积算完后一次替换。需要时可手动开启渐进显示，优先计算中央区域，每一块完成 GPU fence 后再替换对应区域，未完成区域保留表皮。视图区底部显示计算进度；“仅显示表皮”仍不计算内部体积。画布显示尺寸独立于体积计算尺寸。表面与体积共用一个 GPU 作业队列；不透明表面的浮点深度缓冲采用 reverse-Z，避免薄层远景的深度精度损失。

渐进显示复用原本的体积后缓冲，先用当前表皮初始化全部纹理，再按统一缩放坐标及一像素采样边界逐块合成，避免未计算像素、线性采样边界和拼接接缝。每个体积像素仍只计算一次，没有额外低清体积预计算，也不减少单元或射线精度。取消每个 GPU 批次之前重复拷贝整张底图的操作；只更新已完成区域和最终完整画面。批次自适应不再把边缘小块的定时器唤醒延迟误当作大块的每像素 GPU 耗时。主要缩短首次可见体积的等待，完整计算耗时仍取决于数据、画质和显卡；未测量用户设备的加速倍数。

渐进后缓冲不作为下一次操作的完整底图。相机或显示设置变化时，旧任务在 GPU 批次边界取消，恢复完整表皮并丢弃未完成结果；下一任务使用当前视角和设置，避免混合不同条件的体积块。没有匹配表皮时维持原完整帧回退；性能测试继续只统计完整体积帧，不用渐进块充当 FPS。

显式模型增加独立的 **表皮透明度 0%–100%**。调节时自动勾选“仅显示表皮”，保持半透明表面供观察；取消后恢复静止显示完整体积。表皮透明度不改变体密度、孔隙度筛选、几何缓存或属性。网格线仍由原开关控制：表皮完全透明且边线开启时显示线框，关闭边线后只剩背景。透明表皮只显示缓存中的外露面、断层边界和剖切面，不生成所有被删除的内部共享面。

半透明表皮采用加权、近似的顺序无关透明混合：RGBA16F 累加颜色与权重，R16F 累加光学厚度，再统一合成背景；无需按相机在 CPU 上对千万面排序。它能显示前后表面的贡献，但不等同于逐层精确排序或完整体积分。原理参考 [McGuire / Bavoil, Weighted Blended Order-Independent Transparency](https://jcgt.org/published/0002/02/09/)。需要 [EXT_color_buffer_float](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/)；不可用时禁用透明度控制，保留不透明表皮。两个临时透明缓冲合计每像素 10 字节，200 万像素约 20 MB，每帧完成或取消后释放。透明绘制不使用不透明遮挡剔除，重叠面很多时可能降低帧率。0% 透明度仍走原不透明路径。

边线开关、线宽、属性和其他显示设置变化后，等待中的旧帧会在 GPU 批次边界取消，不再把旧样式提交到画布；相机连续运动仍允许完成一帧以避免饿死。最终帧只在 fence 完成且设置仍有效时显示。网格边线关闭时，线宽和内部边线控件同步禁用，但保留它们的设置以便重新开启。加载和性能测试期间禁用状态不会被界面刷新提前解除。

桌面工作区使用视口剩余高度，侧栏单独滚动；去掉了强制 640px 的最小高度。画布绝对定位在视图区内，绘图缓冲尺寸不参与 CSS 网格的固有高度计算。透明复选框固定在各自开关标签内，避免越出侧栏滚动范围。窄屏仍按原设计将设置放在视图区下方，允许正常页面滚动。

孔隙度变化会在独立 Worker 中重建外露面；相机、着色属性、线宽和透明度变化不重建。剖切保留已有外露面并裁掉平面外片元，同时利用原 BVH 叶包围盒筛选切面候选单元，再在片元中通过真实单元求交封闭切面；候选包围矩形不会被当成真实单元。Worker 只保留最新请求，过期的筛选/剖切缓存不会拿来画新条件。重建期间使用低分辨率真实光线预览，并明确显示正在缓存表面；必须等当前筛选与剖切的表面就绪后才开始完整体积细化、报告处理完成。之后旋转始终复用这份清晰表面，包含新暴露的内部边界和剖切面。

CPU 表面 Worker 保留每格孔隙度、活动标志、当前筛选掩码和每 2×2×2 单元的包围盒，不保留全量 XYZ、其他属性或 EPC/HDF5 文件。GPU 上传完成后先转移原始属性与 BVH 数组到 Worker，再压缩和释放。计数索引仍在主线程。生产缓存不再使用原来的 400 万面 / 100 万剖切候选上限：边界索引最多每格 4 字节，剖切候选最多另加每格 4 字节；20M 的两部分分别最多 80 MB。直接分段上传 GPU，不在主线程合并复制大数组。表面程序编译或内存分配失败时仍保留原体积路径，并明确提示旋转使用快速预览。

已验证的碎片化筛选压力用例：规则棋盘式孔隙度使一半单元被筛选掉，保留的每格均暴露六个面（十进制 MB）：

| 模型 | 保留单元 | 实际外露面 | 压缩边界索引 |
| --- | ---: | ---: | ---: |
| 10M | 5,000,000 | 30,000,000 | 20 MB |
| 20M | 10,000,000 | 60,000,000 | 40 MB |

这些数字是实际 CPU 提取和逐格完整性检查结果，不是千万面 GPU 帧率测试；另验证了 500 万 / 1000 万剖切候选不会被截断。索引大小不包含原网格纹理、主线程计数索引、画面/深度缓冲、临时副本及驱动开销。压缩降低存储需求，但不会减少真实要画的三角形数量，碎片化筛选仍可能降低旋转帧率；不保证所有状态均立即清晰或达到 60 FPS。

## 导入 RESQML

在左侧“导入 RESQML”同时选择一个 `.epc` 和它引用的所有 `.h5` / `.hdf5` / `.hdf` 文件，随后选择网格、孔隙度、含油饱和度、渗透率和活动标志，点击“加载并渲染”。属性由支持对象 UUID 关联；同名、多时刻属性由用户选择。文件仅在本机 Worker 内解析，不发送到服务器，也不保存到网站；刷新后需重新选择。

支持范围：

- RESQML 2.0 / 2.0.1 `IjkGridRepresentation`，I-fastest 数组顺序；包括奇数维度和单层网格。
- `Point3dHdf5Array` 显式 XYZ 角点。
- `Point3dParametricArray`：两个控制点、LineKindIndices 全为 1 的直线柱；断层附加柱使用对应主柱控制点及自己的参数值。
- `Point3dLatticeArray`：按 K/J/I 三个偏移与间距数组展开。
- `SplitCoordinateLines` 的柱线索引、列关联及累计长度；`KGaps` 的 GapAfterLayer。
- `CellGeometryIsDefined`、`PillarGeometryIsDefined` 和用户选择的活动属性共同决定有效单元。活动标志可指定“正数为活动”或“0 为活动”。
- 标量、单 patch、关联到 cells 的连续/离散属性；HDF5 数组、常量数组及简单 XML 数组。HDF5 支持取决于所带 HDF5 库，包含已验证的 gzip 压缩；未加载额外压缩插件。
- LocalDepth3dCrs；米、英尺、US survey foot、厘米、毫米、千米坐标单位。保持文件局部 XY 方向，统一长度单位并使 Z 向上，在 Float64 中减去局部中心后转换 Float32；保留原始 CRS XML、偏移和旋转元数据。显示不应用全局平移/旋转，也不进行地图重投影。

孔隙度依据单位转换为 0–1；单位未知时必须选择小数/百分数，不能猜测。导入后筛选范围为 0%–100%，默认关闭筛选以展示全部有效活动几何。开启筛选时，孔隙度缺失/非法值不匹配任何范围；属性缺失的单元着色为灰色。色标根据活动单元有效值计算；正渗透率使用对数色标。没有属性的文件可以只显示几何。

EPC 根据 ZIP 元数据只解压 XML 和关系文件，通过 HDF proxy 的 externalResource 关系匹配用户选择的 HDF5 文件名。使用 h5wasm 的 **WORKERFS 随机访问本地 File**，HDF5 在底层库中切片，临时读取块不超过 524,286 个数值，不整体复制 HDF5 文件到 WASM 内存。CPU 上构建角点、属性和 BVH 后转移数组所有权；上传 GPU 后，属性和包围盒转入独立表面 Worker 压缩，其余大数组释放，导入 Worker 及文件挂载关闭。导入过程支持取消，解析错误时保留此前模型。

导入几何使用整数纹理存储每列四条柱线编号和每层两个原始 K 界面编号，因此不依赖合成模型的固定断层位置。沿邻接遍历前检查共享柱线或 K 界面编号；跨断层、跨层间隙重新查询 BVH。按单元有向体积处理深度轴反向后的面朝向；角点无效或体积退化的活动单元排除并报告数量。

当前限制：

- 不支持 RESQML 2.2、曲线参数柱、截断网格、任意非结构多面体、附加网格点、子表示上的稀疏属性、多 patch 属性、时间域坐标系或仅从父网格继承的几何。
- EPC 上限 128 MB，单个 XML 上限 32 MB，总解压 XML 上限 128 MB。大数组应在外部 HDF5 中。
- 单个导入网格上限 20,000,000 个单元，还必须满足实际 GPU 的 2D/3D 纹理维度和空间索引限制。拆点及 K 间隙会增加存储，不能套用下方合成网格的显存数字。
- 复杂自交、病态单元和相对于整个模型极薄的单元不保证正确渲染。未拿到用户的生产文件；标准格式样例验证不代表所有导出器或真实 20M 模型均已验证。

实现依据：[bp/resqpy](https://github.com/bp/resqpy)、[NIST h5wasm](https://github.com/usnistgov/h5wasm)。第三方依赖固定版本并随站点提供，许可证在 `dist/vendor/LICENSES.txt`，不依赖第三方 CDN。

## 显式模式的数据规模

| 模式 | IJK 尺寸 | 总单元 | 活动单元 | 网格 GPU 数据字节 | CPU 计数索引字节 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1M | 200 × 100 × 50 | 1,000,000 | 952,196 | 43,022,720 | 4,000,000 |
| 10M | 400 × 250 × 100 | 10,000,000 | 9,422,832 | 424,546,048 | 40,000,000 |
| 20M | 500 × 400 × 100 | 20,000,000 | 18,847,792 | 847,430,400 | 80,000,000 |

总数包含非活动单元。每格实际存储 Float32 的 So、孔隙度、渗透率和活动标志，使用 RGBA32F 三维纹理，不使用重复实例、低分辨率替身或虚报的单元数量。每个共享节点存储 Float32 XYZ，按 RGBA32F 对齐；第四分量不参与几何。节点、属性、空间索引和索引填充均计入表中的 GPU 数据量。预览与细化画面缓冲、驱动、画布、浏览器以及上传副本另占内存。

模型在模块 Worker 内生成，使用 transferable ArrayBuffer 转移所有权。主线程上传后释放大数组引用，只保留排序后的活动单元孔隙度和小型元数据；独立表面 Worker 的额外缓存见上文，回收由浏览器决定。切换模型时新数据生成期间旧模型仍在显卡，上传前删除旧纹理，因此切换时的内存峰值高于稳定状态。

## 几何与当前边界

- 角点实际保存 XYZ。每个节点有独立的小幅扰动，叠加三维非线性地层变形；着色器直接读取坐标，不重建变形公式。
- 三个 X 拆点面和一个 Y 拆点面形成八个断块。断层两侧的节点不共享，支持间隙和垂向错动；块内相邻单元共享角点。
- 不规则外轮廓和内部透镜状空区通过非活动标志表达。
- 当前保留 IJK 邻接，单元为八角点六面体。非平面四边形面使用相邻单元一致的两片三角形表示，三角剖分对角线不画作单元边。
- GPU 几何求交与合成数据生成分离，空间索引从实际角点构建；修改角点或活动范围后需要重新构建索引。

本节列出的模型仍是合成数据压力实验；真实文件的支持范围见上方 RESQML 导入说明。尚无 EGRID / GRDECL 导入器。20M 是本页当前可选规模，不是所有独立显卡都能流畅显示的保证。

## 求交、积分与边线

1. 对最多 2×2×2 个单元建立一个 BVH 叶节点；内部节点保存实际活动几何的包围盒和孔隙度范围。20M 有 4,999,999 个节点，深度 22。节点和叶编号均低于 Float32 整数精确表示上限。
2. 沿光线由近到远访问 BVH，跳过不相交或整段孔隙度不匹配的子树。叶节点通过实际单元面的 12 片三角形求出入射/出射区间。求交采用沿光线主轴投影的共享边判断，避免膨胀重心容差造成假命中；每个出口必须匹配真实入口，入口可以位于裁切起点或相机后方。不能因只看到出口就假设相机在单元内部。
3. 在共享面处直接沿 IJK 邻接继续，包括穿过非活动或被筛选排除的邻居；只有断层、块边界或邻接求交失败才重新查询 BVH。这样避免每个属性空隙都从索引根部查找。遍历采用整个树的节点数作为安全上界，不使用演示用的固定几百步截断。
4. 单元属性保持常值。按世界空间路径长度计算 `alpha = 1 - exp(-sigma * length)`，前到后合成；累积 alpha 大于 0.997 时提前结束。
5. 网格线只取原始六面体的 12 条边。剖面线取裁切平面与实际三角面片的交线。筛选后暴露的边界也参与显示，边线与体颜色共用透射率。

远景中小于像素的格子无法逐条分辨。边线抗锯齿并限制物理宽度，避免全部变黑；放大或剖切后仍读取原始角点和属性，没有网格聚合。透明模式通常比厚实体模式更慢，因为光线需要访问更多单元。

## 孔隙度与显示控制

- 合成模型 So 色标 0.05–0.85；孔隙度 8%–32%；渗透率 0.5–1,500 mD，使用对数色标。导入模型使用实际属性范围。
- 显式模型全部属性为 Float32。筛选上下限转换为 Float32 后与实际存储值做包含端点的比较。输入框可输入 0.001 个百分点，滑块步长 0.1。
- 排序的活动单元孔隙度配合二分查找，提供精确匹配数；调整筛选无需在主线程扫描千万格。计数在空间剖切之前进行。关闭筛选仍不显示非活动单元。
- 筛选与着色独立；例如保留孔隙度 18%–25%，同时以含油饱和度着色。
- 默认流畅档限制约 24 万像素；均衡约 52 万、精细约 120 万。还受画布尺寸与设备像素比限制。紧凑模式拖动时暂用约 18 万像素。显式模式的交互预览另见下文。

显式模式优先使用上述清晰表面缓存。缓存重建期间或表面路径不可用时，回退为自适应 3,000–16,000 像素的光线预览：仍从完整原始网格查找最前面的真实匹配单元，保留其边线与剖面交线，但暂不积分后方体积或内部边线。停止操作且表面缓存就绪后，恢复选定分辨率的完整体积分；表面路径不可用则直接细化原光线渲染。预览和完整画面均在离屏缓冲完成后才展示，避免拼接新旧筛选结果。

渲染调度最多保留一个在途 GPU 批次和最新待处理请求。完整画面按小块绘制，每块等待 GPU fence 后让出主线程；新操作取消后续旧块。小预览允许完成一帧，避免持续旋转时反复取消导致画面永远不更新。完整体积与表面预览分别在一帧内根据已完成批次的计时调整尺寸，目标约 8 ms，每批最多 16,384 像素；实际耗时随视线穿过的网格复杂度变化，8 ms 不是硬件保证。批次逐步增长、遇到昂贵区域及时缩小，固定行高配合可变列宽保持所有像素恰好覆盖一次。滑块连续 input 合并 120 ms，释放立即提交；匹配计数同步更新。无匹配单元直接显示背景。

旋转、平移或双指缩放松手后，在下一个安全 GPU 边界先确保显示最终视角的清晰表面，再开始完整体积，取消过去的额外低分辨率预览和固定 200 ms 等待。滚轮、键盘或按住鼠标暂停移动时，从最后一次输入起静默 80 ms 即请求细化，与预览是否完成无关。普通设置先显示最新表面，再立即细化。恢复内部透明体积需要等待体积计算完成，期间保留清晰表面；分辨率、筛选、视角和显卡决定实际总延迟。

页面按需渲染，不把空闲刷新率当作 FPS。“测试完整体积帧率”以选定画质完成所有分块后统计；它不代表快速交互预览帧率。测试逐帧等待 GPU fence 完成，舍弃暖机帧；结果包含显示调度与同步开销，并标注模型、分辨率和滤镜。支持 GPU timer 扩展时显示最近一次有效 GPU 耗时，不支持时明确说明。目标独立显卡的性能需要在页面实测。

## 保留的对照路径

紧凑模式的 1M / 10M / 20M 数据量分别为 4,007,552 / 40,047,072 / 80,088,832 字节。其几何由共享不等距坐标轴、分段仿射地层起伏和两个断块恢复，属性为 8 位量化，全部单元活动；孔隙度间隔约 0.0941 个百分点。它以宏列和砖块 DDA 积分，性能和存储优势依赖这种几何约束。规模切换保留筛选设置。

原始演示仍保留 2,862 个显式八角点单元，逐格分成六个四面体并沿邻接遍历；该路径的 BVH 与光线循环上限只适用于小演示。

## 验证与复现

本版本使用离屏 GLES 数值检查，不执行浏览器视觉测试。验证包括：

- 生产 Worker 的 ArrayBuffer 转移、实际数量、活动掩码、Float32 精确计数、断层拆点、抽样正体积和完整 BVH 父子包围关系。
- 实际上传 10M / 20M 完整纹理，检查透明度、三项属性、XYZ 剖切、筛选、放大边线、正反与俯视方向。全范围筛选和不筛选、范围跳过和不跳过应逐像素完全一致。
- 小网格 1,440 条视线：CPU 用 Float64 求交所有单元的全部四面体，不复用 GPU 的三角面求交、BVH 或邻接遍历。对照体积分 alpha。
- 大模型分别抽取 192 条视线：CPU 用 BVH 仅剔除空间候选，再对所有候选四面体独立求交积分，验证细网格的数值精度。

另构造 82,944 条专门贴近单元边与顶点的光线，检查入口不早于单元包围盒：原算法在该对抗样本中有 12,182 次虚假相机入口，修复后为 0。这个样本针对边界，不代表普通画面的错误比例。

另对生产渲染器模拟延迟 GPU fence，验证 100 次连续设置只保留最新请求、最多一个批次在途、持续旋转仍展示预览、松手直接细化、慢预览不再叠加静默等待、双指手势释放、首帧批次自适应、每像素恰好覆盖一次，以及销毁取消。实际 GLES 对照分块 FBO 和整幅绘制结果，要求筛选、边线和剖切逐像素一致。

这些检查验证数值与实际分配的数据规模，不代表浏览器兼容性穷尽测试，也不代表用户显卡帧率。

```sh
node validate-render-queue.mjs
node validate-render-scheduling.mjs
node validate-explicit.mjs
node validation/export-explicit.mjs /tmp/explicit-small small
python validation/check_explicit_gl.py /tmp/explicit-small
python validation/check_explicit_reference.py /tmp/explicit-small
node validation/export-explicit.mjs /tmp/explicit-20m explicit-20m
python validation/check_explicit_gl.py /tmp/explicit-20m
python validation/check_tiled_gl.py /tmp/explicit-20m
python validation/check_boundary_gl.py /tmp/explicit-20m
python validation/check_explicit_full_reference.py /tmp/explicit-20m
```

导出器分段写入并检查完整文件长度；上传前再次检查字节数，避免部分写入的验证文件被误读。离屏检查需要 Python、NumPy、surfaceless EGL 和 OpenGL ES 3。软件渲染耗时不能代表独立显卡。生成的二进制数据只放临时目录，不提交或发布。

## 代码入口

| 文件 | 用途 |
| --- | --- |
| `dist/explicit-grid.js` | 显式节点、Float32 属性、活动掩码、BVH、精确计数 |
| `dist/explicit-worker.js` | 工作线程生成和转移 |
| `dist/resqml-package.js` | EPC XML、对象 UUID、HDF5 关系、网格与属性目录 |
| `dist/resqml-import.js` | HDF5 分段读取、角点映射、单位转换、活动单元及索引 |
| `dist/resqml-worker.js` | 本地文件 WORKERFS 挂载、解析进度、转移与关闭 |
| `dist/explicit-shaders.js` | 真实三角面求交、邻接步进、体积分与边线 |
| `dist/explicit-renderer.js` | Float32 纹理、交互预览、分块绘制、GPU fence 和完整画面展示 |
| `dist/surface-cache.js` / `dist/surface-worker.js` | 后台压缩、外露面提取、切面候选、最新请求与有界缓存 |
| `dist/surface-raster.js` / `dist/surface-shaders.js` | 实例化外露面、真实切面求交、清晰表面与浮点深度 |
| `dist/render-queue.js` | 单一绘制生产者、最新请求合并和取消 |
| `dist/large-renderer.js` | 复用上传、相机生命周期、分辨率、GPU 计时与性能测试 |
| `dist/large-grid.js` / `dist/large-shaders.js` | 紧凑模型对照 |
| `dist/app.js` | 界面、规模选择和可选 WebMCP |
| `validation/` | 离屏与独立数学参考，不发布到网站 |

纯静态 ES modules。RESQML 导入使用随站点提供的 h5wasm、fflate 和 xmldom；`npm ci` 后执行 `npm run vendor` 可以重建锁定版本的第三方资源。HTTP 提供 `dist/` 即可；模块 Worker 不能通过双击 `file://` 使用。渲染器独立于前端框架，可以在 Angular 视图初始化后创建、销毁时调用 `dispose()`。可选 WebMCP 没有进行浏览器运行验证，普通控件不依赖它。

## RESQML 验证

`validation/make_resqml_fixtures.py` 使用独立的 resqpy 5.2.0 写入、再读回显式角点、直线参数柱和 Lattice 三种 EPC/HDF5 网格。样例包含奇数 IJK 维度、大坐标、英尺单位、深度向下、断层拆点、K 间隙、非活动单元、孔隙度 NaN 和 gzip 压缩属性。

```bash
python validation/make_resqml_fixtures.py /tmp/resqml-fixtures
node validate-resqml.mjs /tmp/resqml-fixtures
node validate-resqml-worker.mjs /tmp/resqml-fixtures
python validation/check_explicit_reference.py /tmp/resqml-fixtures/explicit
python validation/check_tiled_gl.py /tmp/resqml-fixtures/parametric
```

逐单元八角点与 resqpy 读回值比较，并检查活动数、Float32 筛选计数和缺失值处理。Worker 测试执行实际生产 Worker、浏览器版 HDF5 WASM 和 WORKERFS，通过小型 FileReaderSync 文件适配器在 Node 中检查随机读取、转移和卸载。另用大 HDF5 数组检查内维切片顺序与缓冲上限。离屏 GLES 用 Float64 全四面体参考验证 1,440 条视线的体积分，并比较分块与整幅绘制的边线、筛选和剖切像素。未执行浏览器视觉 QA，也未测试用户独立显卡的生产文件性能。

表面缓存检查：

```bash
node validation/export-explicit.mjs /tmp/surface-small small
node validate-surface-cache.mjs /tmp/surface-check /tmp/surface-small
python validation/check_surface_gl.py /tmp/surface-small /tmp/surface-check
node validate-surface-cache.mjs /tmp/surface-resqml /tmp/resqml-fixtures/explicit
python validation/check_surface_gl.py /tmp/resqml-fixtures/explicit /tmp/surface-resqml
python validation/check_surface_transparency.py /tmp/surface-small /tmp/surface-check
python validation/check_surface_transparency.py /tmp/resqml-fixtures/explicit /tmp/surface-resqml
node validate-surface-worker.mjs
node validate-surface-capacity.mjs
node validate-render-scheduling.mjs
```

逐面用独立角点编号比较验证外露面集合、压缩编码分组和切面候选完整性。实际表面 Worker 检查输入/输出转移、连续 100 次更新仅提交最新结果和剖切复用。生产表面 GLSL 的逐面及压缩编码与原 BVH 光线表面在合成与 RESQML 样例上各对照 144 次，覆盖相机/属性/边线/筛选/XYZ 剖切组合，允许三角形边缘的栅格覆盖差异。10M/20M 棋盘筛选验证超出旧缓存上限时仍保留全部面与剖切候选。模拟延迟 GPU fence 的生产调度检查表面缓存完成前不报告处理完成、筛选和 XYZ 剖切完成后旋转无低分辨率帧、不重建缓存、过期缓存不展示、内部体积恢复、细化期间画布不降分辨率，以及始终最多一个批次在途。

加载背景与渐进体积检查：

```bash
node validate-loading-background.mjs
node validate-volume-tiles.mjs /tmp/progressive-tiles.json
node validate-render-scheduling.mjs
python validation/check_progressive_gl.py /tmp/surface-small /tmp/progressive-tiles.json
python validation/check_progressive_gl.py /tmp/resqml-fixtures/explicit /tmp/progressive-tiles.json
```

覆盖动态批次的逐像素无重叠/遗漏、优先中央区域、首块早于完整帧显示、相机/属性/边线/主题/筛选改变后的取消、开关关闭及性能测试不渐进显示。实际 GLES 使用生产分块和补丁坐标，检查未更新区域不变，且最后一块完成后（最终整帧拷贝之前）像素与完整渲染逐像素相同，覆盖合成与 RESQML、浅色/深色、孔隙度筛选和 XYZ 剖切。模拟浏览器合成器的背景测试与离屏 GLES 均不代表用户设备的浏览器性能测量。


### 100% 体密度端点

体密度 0–99% 保留原有吸收系数 `28 * (density / 100) ** 2` 和逐单元透明叠加；100% 明确定义为完全不透明。此前最大值只是有限吸收系数 28，薄层仍然透光，因此此次端点的画面变化是有意的。

显式网格在 100% 时复用当前筛选、剖切的清晰表皮，停止后不再启动内部体积细化，保持原显示分辨率和网格线。表皮尚未缓存或不可用时，GLSL/WGSL 光线路径在第一个匹配单元以 alpha=1 结束。原小网格、结构化大网格着色器也使用完全不透明端点。体渲染模式忽略此前保留的表皮透明度；独立表皮模式和对比右侧仍保留各自透明度。回到 99% 自动恢复透明体积。

验证包含生产 WebGL/WebGPU 调度、100% 时无内部光线/compute 批次、完整像素数、旋转复用、筛选/剖切缓存更新及独立透明度恢复。`validation/check_opaque_endpoint.py` 将合成与 RESQML 样例各 66 幅 100% 画面与改动前的首表面基准逐像素对比；原透明体积回归各 84 幅逐像素一致。这项加速针对完全不透明状态，不代表 0–99% 的精确体积遍历已经实时，也不提供用户独显 FPS 的推断。


### 断层分块实验（WebGL2）

`compare.html?blocks=1` 或 `index.html?blocks=1` 打开实验路径；面板的“分块加速（实验）”可随时切回原路径，保持同一份数据、相机、像素数、属性、筛选和网格线。普通 URL 默认关闭实验。WebGPU 仍使用原路径，不建立额外分块索引。

Worker 在初次加载时按 IJK 断层分区，为原有 2×2×2 叶节点建立保守空间桶。所有与桶相交的叶节点都保留；跨断层的叶节点保持完整包围范围，不裁掉薄单元。复杂断层需要超过 128 个矩形分区时使用全域桶索引。射线在各块内以 DDA 访问空间桶，再对候选单元使用原始角点和精确三角面求交。所有块共享原来的从前到后透明度累积。选择性孔隙度筛选自动使用有属性范围剪枝的 BVH，避免桶索引在窄范围筛选时变慢。连续跨格只复用共享面的四个角点，仍完整计算原有出入区间，不假定扭曲单元只有一个区间。

10M 样例增加约 47.9 MB 索引，本地构建约 0.44 秒；只在加载时建立，旋转和筛选不重建。索引分配受 200 MB、4000 万条引用、Float32 精确偏移及设备纹理尺寸约束；超限或可选 GPU 纹理分配失败时退回原索引。分批提交仍限制最多 65,536 像素、一个批次在途；WebGL 的自适应目标从 8 ms 调到 16 ms，减少等待次数，输入变化仍在当前批次结束后取消。

这不是重采样后的规则 3D 纹理，也不把块内网格当作 Cartesian 网格。本轮测试表明仅改变空间搜索的收益有限。相同 10M、1200×1000、网格线开启、默认相机，在 Mesa llvmpipe 软件图形环境的完整 GPU 绘制加读回测试中：

| 场景 | 原版中位耗时 | 分块/自动回退中位耗时 |
| --- | --- | --- |
| 密度 60% | 0.561 s | 0.507 s |
| 密度 15% | 1.215 s | 1.174 s |
| 孔隙度下限 24% | 0.434 s | 0.425 s |
| X 剖切 38% | 0.343 s | 0.313 s |

原版各两次、最终版各三次热帧；小幅差异会受软件图形环境波动影响，不能推断浏览器等待时间或用户独显 FPS。这些完整帧逐像素一致。没有把这次试验称为实时渲染或数量级提速。

验证：`validate-block-index.mjs` 检查 Float32 边界的保守覆盖、断层/K 间隙和空网格；`validate-block-upload.mjs` 检查每个可选纹理 OOM 位置都保留原几何；生产调度验证索引纹理不会被表皮透明缓冲或输出纹理覆盖。合成与 RESQML 样例各 195 幅 GLES 回归画面与原版逐像素一致，覆盖 XYZ 轴向、体内视角、0/15/60/100% 密度、筛选、剖切和网格线。

早期仅复用上一个出口法线并省略入口选择的方案，在低密度下产生少量较大的颜色差异，已从生产代码删除。更密的空间桶增加显存且没有稳定收益，也未启用。
