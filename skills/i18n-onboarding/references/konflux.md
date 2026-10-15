# Konflux validation

Use this reference when `.tekton/*.yaml` contains PipelineRuns.

1. Read each PipelineRun's `pipelineRef`. A `git` resolver names the shared pipeline by its `url`, `revision`, and `pathInRepo` params. A `pipelineRef` with only `name` (a cluster or bundle pipeline) is not a shared pipeline: record it and leave it out of this track. Judge support only from the exact pinned definition, never from the pipeline name, a newer branch, or a different revision.
2. Fetch each unique `url`, `revision`, and `pathInRepo` combination once, with a single read-only request: `gh api "repos/<owner>/<repo>/contents/<pathInRepo>?ref=<revision>" -H "Accept: application/vnd.github.raw+json"`. Do not clone the repository, list its tree, or follow other files. The track is available only if that definition declares the `i18n-validation-mode` parameter. If the request fails or the parameter is absent, mark the track unavailable and report why in one line.
3. When available, explain that the shared validation step uses `warn` by default. Set `i18n-validation-mode` to `error` in every relevant PipelineRun only when `validate-ci --mode error` passes for the repository. While error findings remain, keep the default and report the switch as pending, with the findings that block it.
4. Keep every PipelineRun pinned to its existing shared pipeline and revision. Do not bump the shared pipeline revision as part of this track.

The reusable validation CLI can write Tekton results with `validate-ci --results-dir <dir>`, but do not add that option to a consumer PipelineRun unless the referenced pipeline step already supports and passes it.
