# Konflux validation

Use this reference when `.tekton/*.yaml` contains PipelineRuns.

1. Read each PipelineRun's `pipelineRef` and resolve the exact shared pipeline and revision it names. Do not infer support from the pipeline name, a newer branch, or a different revision.
2. Inspect that referenced pipeline definition. The track is available only if it declares the `i18n-validation-mode` parameter for the validation step. If the source cannot be resolved or the parameter is absent, mark the track unavailable and report why.
3. When available, explain that the shared validation step uses `warn` by default. Set `i18n-validation-mode` to `error` in every relevant PipelineRun only when `validate-ci --mode error` passes for the repository. While error findings remain, keep the default and report the switch as pending, with the findings that block it.
4. Keep every PipelineRun pinned to its existing shared pipeline and revision. Do not bump the shared pipeline revision as part of this track.

The reusable validation CLI can write Tekton results with `validate-ci --results-dir <dir>`, but do not add that option to a consumer PipelineRun unless the referenced pipeline step already supports and passes it.
