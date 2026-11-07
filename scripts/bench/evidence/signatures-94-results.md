# Issue 94 measured results

Production parent `610c931b7b22920cce59cf03e49c0de15ebaf2a2`; production candidate `999c75d37e1f1d86c25e58b4d45db3f96a66df38`. Build tools are Node 24.19.0, pnpm 11.7.0 and tsc-rs 0.7.0 with the same frozen lockfile. The clean builds were copied and hashed before switching refs; source hashes were independently checked against Git. See the original receipts and the install-once/per-pin-command execution supplement in the raw archive.

The small/read/worker matrix used harness `b31d7a2eeec8ec302687b158bbdfeb0a2ec69335`. History used `e6b8bbb6883b8f3de4fc974a43500b866bcda7c9`, after restoring the inherited I/O parser. The timing region is byte-identical and signature-path counter parsing is equivalent. Companion fingerprints are recorded per process. Production files are unchanged between these harness pins.

Each cell has five independent process samples per variant, interleaved parent/key-only/full with order reversed on alternate pairs. Each process has separate setup, then a cold first snapshot and warmed reads. Synthetic roots used Linux tmpfs; filesystem caches are uncontrolled/warm. No concurrent heavy owner ran. The key-only adapter is benchmark-only candidate code and is never labeled the production baseline. Repeated snapshots/churn rounds are summarized within each process, not treated as independent samples. No p95 is inferred.

## Primary process CPU

Values are median [min, max] milliseconds across five processes. CPU covers the complete production operation and assertions. Deltas compare medians; paired CPU reductions are also shown. Parent and key-only are separate comparisons.

| Node | Records | Body bytes | Operation | Parent CPU | Key-only CPU | Full CPU | Full vs parent | Full vs keys | Paired reduction vs parent |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| v20.20.2 | 0 | 10240 | list | 2.152 [1.931, 2.206] | 1.755 [1.657, 2.006] | 1.850 [1.453, 1.963] | 0.302 ms, 14.0% | -0.095 ms, -5.4% | 12.9% [-1.7, 32.5] |
| v20.20.2 | 0 | 10240 | worker-noop-validated-custody | 215.953 [212.018, 219.690] | 189.348 [188.311, 190.487] | 189.366 [185.889, 193.034] | 26.587 ms, 12.3% | -0.018 ms, -0.0% | 11.3% [10.6, 15.4] |
| v20.20.2 | 100 | 10240 | get | 38.107 [35.619, 40.543] | 20.318 [19.632, 22.627] | 7.227 [6.987, 7.823] | 30.880 ms, 81.0% | 13.091 ms, 64.4% | 81.1% [79.5, 81.7] |
| v20.20.2 | 100 | 10240 | list | 62.616 [60.402, 65.237] | 49.001 [46.572, 51.028] | 32.723 [30.417, 33.357] | 29.893 ms, 47.7% | 16.278 ms, 33.2% | 47.8% [45.8, 52.8] |
| v20.20.2 | 100 | 10240 | worker-noop-validated-custody | 16705.041 [16531.263, 16771.119] | 9867.501 [9779.816, 10068.782] | 5802.913 [5678.593, 6060.510] | 10902.128 ms, 65.3% | 4064.588 ms, 41.2% | 64.9% [63.5, 66.0] |
| v20.20.2 | 100 | 1048576 | get | 40.016 [37.186, 41.521] | 23.436 [21.405, 24.289] | 9.292 [8.783, 9.965] | 30.724 ms, 76.8% | 14.144 ms, 60.4% | 77.2% [73.2, 78.1] |
| v20.20.2 | 100 | 1048576 | list | 60.663 [58.094, 63.974] | 45.826 [44.126, 48.303] | 31.191 [29.895, 31.813] | 29.472 ms, 48.6% | 14.635 ms, 31.9% | 50.2% [46.5, 50.7] |
| v20.20.2 | 100 | 1048576 | worker-noop-validated-custody | 16639.967 [16501.985, 16835.221] | 10118.183 [9797.939, 10250.347] | 5825.379 [5730.740, 5869.320] | 10814.588 ms, 65.0% | 4292.804 ms, 42.4% | 65.2% [65.0, 65.4] |
| v24.19.0 | 0 | 10240 | list | 1.558 [1.443, 1.807] | 1.801 [1.449, 1.965] | 1.716 [1.383, 2.045] | -0.158 ms, -10.1% | 0.085 ms, 4.7% | -11.0% [-41.7, 23.0] |
| v24.19.0 | 0 | 10240 | worker-noop-validated-custody | 154.838 [153.691, 166.606] | 152.836 [151.682, 154.901] | 151.913 [150.292, 153.856] | 2.925 ms, 1.9% | 0.923 ms, 0.6% | 1.4% [0.6, 9.4] |
| v24.19.0 | 100 | 10240 | get | 24.210 [22.459, 26.312] | 20.026 [19.312, 21.823] | 7.258 [6.729, 7.613] | 16.952 ms, 70.0% | 12.768 ms, 63.8% | 69.7% [66.1, 74.4] |
| v24.19.0 | 100 | 10240 | list | 36.881 [34.929, 37.500] | 32.518 [32.167, 34.256] | 19.879 [19.461, 21.090] | 17.002 ms, 46.1% | 12.639 ms, 38.9% | 46.6% [40.1, 48.1] |
| v24.19.0 | 100 | 10240 | worker-noop-validated-custody | 8478.097 [8392.955, 8643.865] | 7730.074 [7648.535, 7891.108] | 3631.093 [3579.859, 3708.059] | 4847.004 ms, 57.2% | 4098.981 ms, 53.0% | 57.2% [56.7, 57.4] |
| v24.19.0 | 100 | 1048576 | get | 25.330 [24.533, 26.009] | 23.057 [21.837, 24.013] | 9.205 [9.043, 9.996] | 16.125 ms, 63.7% | 13.852 ms, 60.1% | 63.4% [61.6, 64.3] |
| v24.19.0 | 100 | 1048576 | list | 35.964 [35.265, 38.254] | 34.913 [33.018, 37.472] | 20.415 [20.026, 21.416] | 15.549 ms, 43.2% | 14.498 ms, 41.5% | 42.8% [40.5, 46.6] |
| v24.19.0 | 100 | 1048576 | worker-noop-validated-custody | 8675.161 [8520.268, 8797.303] | 8060.324 [7863.257, 8112.729] | 3850.969 [3805.497, 3917.892] | 4824.192 ms, 55.6% | 4209.355 ms, 52.2% | 55.3% [54.8, 56.7] |
| v20.20.2 | 1000 | 10240 | get | 369.729 [341.656, 381.529] | 191.670 [177.235, 204.049] | 61.443 [57.971, 69.523] | 308.286 ms, 83.4% | 130.227 ms, 67.9% | 83.9% [79.7, 84.6] |
| v20.20.2 | 1000 | 10240 | list | 455.473 [419.128, 541.760] | 279.722 [261.214, 285.681] | 140.404 [138.501, 147.295] | 315.069 ms, 69.2% | 139.318 ms, 49.8% | 69.0% [67.0, 72.8] |
| v24.19.0 | 1000 | 10240 | get | 199.258 [183.875, 220.765] | 176.617 [162.909, 188.169] | 33.606 [33.048, 34.874] | 165.652 ms, 83.1% | 143.011 ms, 81.0% | 83.0% [81.7, 84.8] |
| v24.19.0 | 1000 | 10240 | list | 267.872 [266.317, 283.386] | 245.713 [225.347, 251.167] | 89.300 [87.555, 92.786] | 178.572 ms, 66.7% | 156.413 ms, 63.7% | 67.2% [65.4, 67.7] |

## Supporting elapsed time

| Node | Records | Body bytes | Operation | Parent ms | Key-only ms | Full ms |
|---|---:|---:|---|---:|---:|---:|
| v20.20.2 | 0 | 10240 | list | 2.458 [1.787, 3.174] | 2.509 [1.854, 2.632] | 2.156 [1.372, 2.255] |
| v20.20.2 | 0 | 10240 | worker-noop-validated-custody | 172.599 [165.074, 186.224] | 145.757 [144.828, 146.253] | 146.148 [141.617, 146.414] |
| v20.20.2 | 100 | 10240 | get | 37.759 [35.610, 40.169] | 20.232 [19.665, 22.507] | 7.666 [6.429, 8.022] |
| v20.20.2 | 100 | 10240 | list | 52.774 [52.542, 56.165] | 38.975 [34.998, 41.087] | 23.080 [21.355, 24.923] |
| v20.20.2 | 100 | 10240 | worker-noop-validated-custody | 15935.064 [15752.953, 16022.707] | 9126.808 [9061.014, 9462.657] | 5216.806 [5062.044, 5616.609] |
| v20.20.2 | 100 | 1048576 | get | 40.494 [37.797, 42.350] | 23.520 [21.919, 24.290] | 9.024 [8.294, 10.429] |
| v20.20.2 | 100 | 1048576 | list | 52.047 [49.642, 57.433] | 37.054 [35.112, 39.683] | 22.297 [21.048, 23.541] |
| v20.20.2 | 100 | 1048576 | worker-noop-validated-custody | 15773.453 [15667.177, 16051.651] | 9369.293 [9178.030, 9602.268] | 5222.060 [5107.797, 5261.410] |
| v24.19.0 | 0 | 10240 | list | 1.381 [1.285, 2.064] | 2.162 [1.475, 2.431] | 2.132 [1.359, 2.731] |
| v24.19.0 | 0 | 10240 | worker-noop-validated-custody | 131.178 [130.524, 203.179] | 131.436 [130.322, 136.188] | 130.862 [126.230, 132.064] |
| v24.19.0 | 100 | 10240 | get | 23.009 [22.145, 23.342] | 19.282 [18.066, 20.539] | 6.259 [5.515, 6.745] |
| v24.19.0 | 100 | 10240 | list | 37.052 [35.079, 38.352] | 33.215 [31.474, 34.547] | 19.469 [18.738, 21.447] |
| v24.19.0 | 100 | 10240 | worker-noop-validated-custody | 8177.667 [8063.325, 8306.310] | 7521.249 [7425.384, 7602.824] | 3340.980 [3272.323, 3412.817] |
| v24.19.0 | 100 | 1048576 | get | 25.132 [24.109, 25.461] | 21.562 [21.106, 23.112] | 9.227 [8.923, 9.379] |
| v24.19.0 | 100 | 1048576 | list | 37.404 [35.443, 39.989] | 36.067 [33.216, 41.652] | 21.352 [20.651, 22.440] |
| v24.19.0 | 100 | 1048576 | worker-noop-validated-custody | 8299.505 [8132.567, 8317.275] | 7665.692 [7494.098, 7749.002] | 3446.042 [3377.261, 3488.052] |
| v20.20.2 | 1000 | 10240 | get | 346.549 [313.800, 393.456] | 178.993 [165.353, 184.971] | 43.705 [40.297, 45.308] |
| v20.20.2 | 1000 | 10240 | list | 399.482 [363.799, 489.850] | 235.796 [218.384, 242.208] | 96.414 [95.274, 102.612] |
| v24.19.0 | 1000 | 10240 | get | 194.812 [179.360, 215.976] | 173.411 [159.276, 184.819] | 30.157 [29.383, 31.516] |
| v24.19.0 | 1000 | 10240 | list | 250.189 [246.456, 263.938] | 226.079 [204.423, 232.681] | 80.025 [76.187, 81.686] |

## Cold, churn and warm startup CPU

The first snapshot starts with a fresh application cache; the parent has no verification cache. Warm startup happens after reads and validated custody preparation. It is an in-process owned-runtime start, not a cold daemon/subprocess launch.

| Node | Records | Body bytes | Operation | Parent CPU ms | Key-only CPU ms | Full CPU ms |
|---|---:|---:|---|---:|---:|---:|
| v20.20.2 | 0 | 10240 | churn-miss | 2.102 [1.970, 2.252] | 1.641 [1.563, 1.803] | 1.608 [1.567, 1.696] |
| v20.20.2 | 0 | 10240 | churn-repeat | 2.014 [1.701, 2.077] | 1.771 [1.604, 2.575] | 1.821 [1.565, 2.823] |
| v20.20.2 | 0 | 10240 | snapshot-cold | 6.239 [6.107, 6.931] | 6.444 [6.226, 6.658] | 6.421 [6.333, 6.520] |
| v20.20.2 | 0 | 10240 | worker-close | 4.849 [4.011, 5.201] | 4.303 [4.041, 4.663] | 4.841 [4.341, 6.420] |
| v20.20.2 | 0 | 10240 | worker-idle | 28.158 [20.695, 39.492] | 63.052 [44.486, 63.920] | 62.129 [37.126, 65.693] |
| v20.20.2 | 0 | 10240 | worker-startup | 27.917 [26.829, 30.266] | 33.570 [33.217, 35.777] | 34.668 [33.534, 35.456] |
| v20.20.2 | 100 | 10240 | churn-miss | 36.179 [34.024, 37.669] | 18.446 [18.117, 20.352] | 19.054 [18.848, 19.114] |
| v20.20.2 | 100 | 10240 | churn-repeat | 39.891 [37.996, 40.961] | 19.391 [18.027, 20.015] | 5.848 [5.795, 7.993] |
| v20.20.2 | 100 | 10240 | snapshot-cold | 48.053 [43.602, 50.165] | 30.759 [29.153, 32.245] | 33.773 [30.840, 34.604] |
| v20.20.2 | 100 | 10240 | worker-close | 3.595 [3.263, 3.972] | 4.065 [3.145, 45.829] | 3.304 [3.084, 3.438] |
| v20.20.2 | 100 | 10240 | worker-idle | 231.694 [198.130, 294.438] | 193.402 [173.387, 287.838] | 114.955 [77.313, 119.807] |
| v20.20.2 | 100 | 10240 | worker-startup | 199.893 [186.235, 209.194] | 124.409 [120.597, 127.437] | 72.699 [70.190, 76.643] |
| v20.20.2 | 100 | 1048576 | churn-miss | 39.497 [37.472, 39.964] | 18.594 [18.038, 19.994] | 19.331 [19.119, 21.525] |
| v20.20.2 | 100 | 1048576 | churn-repeat | 39.209 [38.602, 41.418] | 18.993 [18.227, 20.372] | 5.998 [5.780, 8.026] |
| v20.20.2 | 100 | 1048576 | snapshot-cold | 47.568 [43.908, 50.554] | 29.096 [28.204, 31.644] | 32.449 [30.843, 33.195] |
| v20.20.2 | 100 | 1048576 | worker-close | 3.881 [3.736, 5.451] | 3.738 [3.572, 6.389] | 3.749 [3.648, 5.502] |
| v20.20.2 | 100 | 1048576 | worker-idle | 279.239 [261.702, 297.951] | 250.320 [102.354, 281.293] | 112.286 [72.109, 126.166] |
| v20.20.2 | 100 | 1048576 | worker-startup | 194.368 [182.902, 196.203] | 120.362 [114.514, 128.580] | 74.090 [69.750, 78.081] |
| v24.19.0 | 0 | 10240 | churn-miss | 1.554 [1.508, 1.661] | 1.514 [1.433, 1.625] | 1.455 [1.374, 1.509] |
| v24.19.0 | 0 | 10240 | churn-repeat | 1.570 [1.517, 1.600] | 1.448 [1.397, 1.526] | 1.484 [1.440, 1.523] |
| v24.19.0 | 0 | 10240 | snapshot-cold | 6.087 [5.867, 6.534] | 6.205 [5.998, 6.340] | 6.199 [5.987, 6.470] |
| v24.19.0 | 0 | 10240 | worker-close | 3.799 [3.710, 4.286] | 4.046 [3.541, 4.404] | 3.901 [3.649, 3.951] |
| v24.19.0 | 0 | 10240 | worker-idle | 26.708 [23.942, 28.522] | 26.463 [18.790, 27.395] | 27.243 [24.649, 28.741] |
| v24.19.0 | 0 | 10240 | worker-startup | 26.766 [26.089, 28.918] | 26.235 [25.608, 29.060] | 25.805 [24.967, 27.120] |
| v24.19.0 | 100 | 10240 | churn-miss | 25.554 [25.205, 27.966] | 17.583 [17.504, 20.373] | 19.431 [19.056, 25.361] |
| v24.19.0 | 100 | 10240 | churn-repeat | 25.033 [24.739, 26.754] | 18.361 [17.578, 20.441] | 5.119 [4.783, 7.651] |
| v24.19.0 | 100 | 10240 | snapshot-cold | 31.703 [31.108, 32.865] | 28.251 [28.095, 29.885] | 30.262 [29.718, 32.960] |
| v24.19.0 | 100 | 10240 | worker-close | 3.684 [3.254, 51.753] | 3.395 [2.946, 28.338] | 3.175 [2.861, 9.663] |
| v24.19.0 | 100 | 10240 | worker-idle | 171.286 [111.227, 206.772] | 161.257 [146.875, 192.959] | 81.498 [73.578, 96.953] |
| v24.19.0 | 100 | 10240 | worker-startup | 122.558 [116.655, 124.880] | 115.781 [115.474, 118.428] | 57.736 [56.798, 62.295] |
| v24.19.0 | 100 | 1048576 | churn-miss | 24.609 [24.206, 26.530] | 17.424 [16.880, 19.739] | 19.221 [18.937, 20.414] |
| v24.19.0 | 100 | 1048576 | churn-repeat | 24.727 [24.576, 27.194] | 17.519 [17.353, 19.277] | 4.447 [4.251, 4.885] |
| v24.19.0 | 100 | 1048576 | snapshot-cold | 31.915 [30.449, 32.112] | 30.516 [28.444, 31.450] | 29.927 [29.498, 31.990] |
| v24.19.0 | 100 | 1048576 | worker-close | 3.576 [3.456, 33.600] | 3.540 [3.433, 23.492] | 3.713 [3.585, 5.263] |
| v24.19.0 | 100 | 1048576 | worker-idle | 166.750 [165.593, 209.514] | 173.621 [135.231, 198.603] | 84.660 [71.621, 93.670] |
| v24.19.0 | 100 | 1048576 | worker-startup | 127.508 [124.876, 133.618] | 110.944 [108.472, 122.201] | 58.434 [56.786, 59.993] |
| v20.20.2 | 1000 | 10240 | churn-miss | 359.376 [347.457, 367.111] | 186.485 [184.491, 188.815] | 197.653 [193.919, 203.386] |
| v20.20.2 | 1000 | 10240 | churn-repeat | 356.605 [341.095, 364.105] | 184.411 [182.584, 185.948] | 47.731 [47.094, 48.349] |
| v20.20.2 | 1000 | 10240 | snapshot-cold | 442.197 [402.773, 474.579] | 264.403 [247.797, 284.863] | 289.931 [279.807, 301.957] |
| v24.19.0 | 1000 | 10240 | churn-miss | 197.867 [181.423, 199.769] | 174.275 [167.634, 180.125] | 176.490 [169.014, 191.055] |
| v24.19.0 | 1000 | 10240 | churn-repeat | 191.885 [181.358, 201.363] | 173.725 [162.619, 179.642] | 30.817 [30.593, 30.889] |
| v24.19.0 | 1000 | 10240 | snapshot-cold | 245.750 [236.127, 247.439] | 221.807 [204.908, 228.767] | 230.240 [222.472, 234.088] |

## Retention and peak memory

Values below are post-GC heap/RSS and cumulative peak RSS, MiB. Repeated rounds use the maximum post-GC value within each process, then the median across the five process maxima. They include fixture/validation objects and both peers when the worker runs, not just the cache. Cache bytes are charged input budgets, not measured V8/native memory. Both peers share one singleton in one Node process. Linux wait4 peak RSS is the largest process high-water mark, not aggregate process-tree RSS. Explicit pre/post-operation GC is excluded from operation CPU/time; natural GC inside operations remains included. Whole-process raw samples include setup and explicit GC.

| Node | Records | Body bytes | Operation | Parent heap/RSS/peak | Keys heap/RSS/peak | Full heap/RSS/peak | Full retained cache entries/charged MiB |
|---|---:|---:|---|---:|---:|---:|---:|
| v20.20.2 | 0 | 10240 | churn-repeat | 6.81/67.00/67.47 | 6.83/66.37/67.32 | 6.83/66.17/67.16 | 0/0.000 |
| v20.20.2 | 0 | 10240 | worker-noop-validated-custody | 6.81/66.47/67.09 | 6.82/66.18/66.82 | 6.82/66.04/66.69 | 0/0.000 |
| v20.20.2 | 100 | 10240 | churn-repeat | 8.09/109.15/119.93 | 8.17/109.66/119.70 | 8.46/110.04/140.24 | 400/0.532 |
| v20.20.2 | 100 | 10240 | get | 5.33/59.18/59.18 | 5.36/59.04/59.04 | 5.41/59.17/59.17 | 100/0.133 |
| v20.20.2 | 100 | 10240 | worker-noop-validated-custody | 8.35/117.23/119.93 | 8.39/116.34/119.70 | 8.53/127.85/140.24 | 100/0.133 |
| v20.20.2 | 100 | 1048576 | churn-repeat | 8.01/120.06/133.92 | 8.00/119.01/139.26 | 8.29/109.03/140.15 | 400/0.534 |
| v20.20.2 | 100 | 1048576 | get | 5.33/61.15/62.15 | 5.35/60.81/61.75 | 5.41/61.20/62.11 | 100/0.133 |
| v20.20.2 | 100 | 1048576 | worker-noop-validated-custody | 8.38/128.41/133.92 | 8.37/125.25/139.26 | 8.47/127.54/140.15 | 100/0.133 |
| v24.19.0 | 0 | 10240 | churn-repeat | 8.86/78.10/78.10 | 8.86/78.27/78.27 | 8.86/78.19/78.19 | 0/0.000 |
| v24.19.0 | 0 | 10240 | worker-noop-validated-custody | 8.82/77.97/77.97 | 8.83/78.08/78.08 | 8.83/78.06/78.06 | 0/0.000 |
| v24.19.0 | 100 | 10240 | churn-repeat | 8.91/161.37/172.50 | 9.06/160.83/170.96 | 9.32/156.73/169.16 | 400/0.532 |
| v24.19.0 | 100 | 10240 | get | 7.09/72.68/72.68 | 7.12/71.98/71.98 | 7.16/72.65/72.65 | 100/0.133 |
| v24.19.0 | 100 | 10240 | worker-noop-validated-custody | 9.25/161.52/172.50 | 9.28/160.27/170.96 | 9.34/156.81/169.16 | 100/0.133 |
| v24.19.0 | 100 | 1048576 | churn-repeat | 8.83/301.76/310.25 | 8.89/314.07/323.66 | 9.11/305.90/324.47 | 400/0.534 |
| v24.19.0 | 100 | 1048576 | get | 7.09/74.21/75.16 | 7.12/73.95/74.93 | 7.16/74.43/75.41 | 100/0.133 |
| v24.19.0 | 100 | 1048576 | worker-noop-validated-custody | 9.21/293.41/310.25 | 9.24/295.16/314.99 | 9.26/302.65/321.44 | 100/0.133 |
| v20.20.2 | 1000 | 10240 | churn-repeat | 8.64/98.46/101.45 | 8.63/97.09/99.45 | 16.31/106.81/107.83 | 11984/16.000 |
| v20.20.2 | 1000 | 10240 | get | 6.44/95.27/95.99 | 6.46/92.47/93.21 | 7.06/94.93/96.17 | 1000/1.333 |
| v24.19.0 | 1000 | 10240 | churn-repeat | 9.50/101.77/102.99 | 9.57/101.39/102.14 | 17.23/114.18/115.44 | 11984/16.000 |
| v24.19.0 | 1000 | 10240 | get | 8.07/95.90/96.64 | 8.10/93.86/94.59 | 8.71/100.03/100.70 | 1000/1.333 |

## Decision and tradeoffs

Local GO for the measured repeated-read and warm steady-state no-op scope. Full local verification and both independent reviews passed; post-review doc-head CI and root audit/approval remain gates. Full 100/1,000-record list/get and prepared 100-record worker CPU improve in every paired process sample on both runtimes. The separate key-only variant does not explain most of the Node 24 gain and leaves a practical additional CPU saving on Node 20. This supports keeping successful-verification retention alongside parsed-key reuse.

There are costs. At 1,000 records, full cold-snapshot CPU is 289.931 ms versus 264.403 ms key-only on Node 20, and 230.240 versus 221.807 ms on Node 24. Miss/churn CPU is 197.653 versus 186.485 ms key-only on Node 20 and 176.490 versus 174.275 ms on Node 24. Both remain below the corresponding uncached parent in these cells. No empty-workload speedup is claimed: the Node 20 empty warm runtime start is 34.668 ms CPU versus 27.917 ms parent, and the one-second idle window is 62.129 versus 28.158 ms. These short windows do not establish long-term idle CPU behavior; the underlying reason for this difference was not investigated.

Under large signed-history churn, the median of per-process maximum post-GC heap is 16.31 versus 8.64 MiB parent on Node 20 and 17.23 versus 9.50 MiB on Node 24. Charged cache input retention reaches but never exceeds 16 MiB and then evicts. Some worker RSS/peak cells regress beyond the charged cache size; for example Node 20 100-record/10 KiB worker peak RSS is 140.24 versus 119.93 MiB parent. V8/native allocations, fixture/TLS state and allocator high-water behavior are included. The input budget is not a total-process RSS cap. The raw values and spread are retained; these costs are accepted for the repeatable full-operation CPU savings within the measured scope.

## Workload and evidence limits

List checks exact complete metadata and ordering; get checks exact metadata and body bytes after global validation. Every worker fixture establishes actual receiver custody through public completeInventory/apply/acknowledge, validates all records/descriptors/receipt counts/body bytes with production reads, and requires a confirmed real authenticated TLS reconciliation with zero transfers before timing. Timed worker no-op then requires confirmed status and zero transfers, validates custody again and checks runtime/server/port cleanup. This does not qualify initial delivery or separate hosts. Startup is already warm and both peers share the process-wide cache.

History cells independently complete cold/warm snapshots, full list/get, 18 rounds at 1,000 records, repeated reads and warmed tamper rejection. They exceed 18,000 successful signed inputs and check bounds each operation. Real signature/field/key corruption still rejects globally. The module tests also exercise entry/byte eviction, oversized bypass, Buffer mutation and invalid-key behavior. Store tests cover unchanged generation/mtime, unrelated-record corruption, schema/permissions/anchor/barrier/reader identity, key rotation, restore/fork and concurrent replacement.

The original parent 1,000-record real-TLS receiver setup failed to confirm within the 300-second run budget, 59 confirmed/941 pending, aborted/local-validation-or-storage-failed, measured process 303,368 ms. The original 100-record Node 20 initial worker pass also aborted under its unchanged 60-second budget, 48 confirmed/52 pending, measured process 61,350 ms. Underlying causes are unresolved. Their raw stdout/failures/cleanup are preserved; partial reads in failed processes are excluded from completed paired cells. Earlier successful pilots and the superseded empty cells are retained but excluded from the qualified matrix. No slow successful matrix sample was discarded.

Initial-sync, large-worker, 10,000-record and over-capacity repeating-scan performance remain unqualified. FIFO scans beyond entry/byte capacity can have zero hits while paying insertion/eviction costs. The bounded 18-round changing-history test does not qualify that repeating-scan regime. The scope supports repeated full reads and the explicitly prepared warm 100-record configured worker no-op. No inference from snapshot timing establishes a large-worker speedup. The raw archive contains every matrix command, sample/stdout, environment/fingerprint, cleanup, failed/superseded pilot, build receipt, supplement and parser red/green/equivalence receipt. Compiled builds are not committed; rebuild the pinned sources and verify their manifests.

The intended repeated consumers are viewer/hub managed backends/sources and worker snapshots/passes within one process. A one-read-per-state command only benefits from parsed-key reuse and pays the additional success-cache miss cost; no state survives process exit. Global scans and worker growth remain unchanged. Correctness/full verification, all review dispositions and the scoped decision are recorded in the main issue 94 receipt. Keep the PR draft for review/CI/root gates.
