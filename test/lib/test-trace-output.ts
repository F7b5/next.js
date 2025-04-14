import * as path from 'node:path'

export function getCurrentTestTraceOutputDir() {
  const testRootDir = path.resolve(__dirname, '..')
  const traceDir = path.join(testRootDir, 'traces')
  const testPathRelativeToTestDir = path.relative(
    testRootDir,
    process.env.TEST_FILE_PATH
  )
  const traceSubDir = testPathRelativeToTestDir.replace(/\//g, '--')
  return path.join(traceDir, traceSubDir)
}
