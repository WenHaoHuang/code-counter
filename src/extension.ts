// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'graceful-fs'
import LineCounter from './LineCounter'
import Gitignore from './Gitignore'
import * as JSONC from 'jsonc-parser'
import * as minimatch from 'minimatch'

const EXTENSION_NAME = 'CodeCounter'
const CONFIGURATION_SECTION = 'CodeCounter'
const toZeroPadString = (num: number, fig: number) => num.toString().padStart(fig, '0')
const dateToString = (date: Date) =>
  `${date.getFullYear()}-${toZeroPadString(date.getMonth() + 1, 2)}-${toZeroPadString(date.getDate(), 2)}` +
  ` ${toZeroPadString(date.getHours(), 2)}:${toZeroPadString(date.getMinutes(), 2)}:${toZeroPadString(date.getSeconds(), 2)}`
const toStringWithCommas = (obj: any) => {
  if (typeof obj === 'number') {
    return new Intl.NumberFormat('en-US').format(obj)
  } else {
    return obj.toString()
  }
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(`${EXTENSION_NAME} is activate!`)

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const codeCountController = new CodeCounterController()
  context.subscriptions.push(
    codeCountController,
    vscode.commands.registerCommand('extension.code-counter.countInDirectory', (targetDir: vscode.Uri | undefined) => codeCountController.countInDirectory(targetDir))
  )
}

// this method is called when your extension is deactivated
export function deactivate() {}

class CodeCounterController {
  private configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION)
  private codeCounter_: CodeCounter | null = null
  private disposable: vscode.Disposable
  constructor() {
    // subscribe to selection change and editor activation events
    let subscriptions: vscode.Disposable[] = []
    vscode.window.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditor, this, subscriptions)
    vscode.workspace.onDidChangeConfiguration(this.onDidChangeConfiguration, this, subscriptions)
    vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this, subscriptions)
    // create a combined disposable from both event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions)
    if (this.isVisible) {
      this.codeCounter.countCurrentFile()
    }
  }
  dispose() {
    this.disposable.dispose()
    this.disposeCodeCounter()
  }
  private get codeCounter() {
    if (this.codeCounter_ === null) {
      console.log(`[${EXTENSION_NAME}] create CodeCounter`)
      this.codeCounter_ = new CodeCounter(this.configuration)
    }
    return this.codeCounter_
  }
  private disposeCodeCounter() {
    if (this.codeCounter_ !== null) {
      this.codeCounter_.dispose()
      this.codeCounter_ = null
      console.log(`[${EXTENSION_NAME}] dispose CodeCounter`)
    }
  }
  private get isVisible() {
    return this.configuration.get('showInStatusBar', false)
  }
  public toggleVisible() {
    this.configuration.update('showInStatusBar', !this.isVisible)
  }
  public countInDirectory(targetDir: vscode.Uri | undefined) {
    const dir = vscode.workspace.rootPath
    if (targetDir !== undefined) {
      this.codeCounter.countLinesInDirectory(targetDir.fsPath)
    } else {
      const option = {
        value: dir || '',
        placeHolder: 'Input Directory Path',
        prompt: 'Input Directory Path. '
      }
      vscode.window.showInputBox(option).then(dirPath => {
        if (dirPath !== undefined) {
          this.codeCounter.countLinesInDirectory(dirPath)
        }
      })
    }
  }
  public countInWorkspace() {
    const dir = vscode.workspace.rootPath
    if (dir !== undefined) {
      this.codeCounter.countLinesInDirectory(dir)
    } else {
      vscode.window.showErrorMessage(`[${EXTENSION_NAME}] No open workspace`)
    }
  }
  private onDidChangeActiveTextEditor(e: vscode.TextEditor | undefined) {
    if (this.codeCounter_ !== null) {
      console.log(`[${EXTENSION_NAME}] onDidChangeActiveTextEditor()`)
      this.codeCounter.countFile(e !== undefined ? e.document : undefined)
    }
  }
  private onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
    if (this.codeCounter_ !== null) {
      console.log(`[${EXTENSION_NAME}] onDidChangeTextDocument()`)
      this.codeCounter.countFile(e.document)
    }
  }
  private onDidChangeConfiguration() {
    const newConf = vscode.workspace.getConfiguration(CONFIGURATION_SECTION)
    if (JSON.stringify(this.configuration) !== JSON.stringify(newConf)) {
      console.log(`[${EXTENSION_NAME}] onDidChangeConfiguration()`)
      this.configuration = newConf
      this.disposeCodeCounter()
      if (this.isVisible) {
        this.codeCounter.countCurrentFile()
      }
    }
  }
}

class CodeCounter {
  private outputChannel: vscode.OutputChannel | null = null
  private statusBarItem: vscode.StatusBarItem | null = null
  private configuration: vscode.WorkspaceConfiguration
  private lineCounterTable: LineCounterTable

  constructor(configuration: vscode.WorkspaceConfiguration) {
    this.configuration = configuration
    this.lineCounterTable = new LineCounterTable(this.configuration)
    if (this.getConf('showInStatusBar', false)) {
      this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)
    }
  }
  dispose() {
    if (this.statusBarItem !== null) {
      this.statusBarItem.dispose()
    }
    if (this.outputChannel !== null) {
      this.outputChannel.dispose()
    }
  }
  private getConf<T>(section: string, defaultValue: T): T {
    return this.configuration.get(section, defaultValue)
  }
  private toOutputChannel(text: string) {
    if (this.outputChannel === null) {
      this.outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME)
    }
    this.outputChannel.show()
    this.outputChannel.appendLine(text)
  }
  public countLinesInDirectory(dir: string) {
    console.log(`[${EXTENSION_NAME}] countLinesInDirectory : ${dir}`)
    const confFiles = vscode.workspace.getConfiguration('files', null)
    const workspaceDir = vscode.workspace.rootPath || `.${path.sep}`
    const outputDir = this.getConf('outputDirectory', '.CodeCounter')
    const outputDirPath = path.resolve(workspaceDir, outputDir)
    const ignoreUnsupportedFile = this.getConf('ignoreUnsupportedFile', true)
    const includes = this.getConf<Array<string>>('include', ['**/*'])
    const excludes = this.getConf<Array<string>>('exclude', [])
    // const associations = confFiles.get<Map<string,any>>('associations', new Map<string,any>());
    const findLineCounter = (() => {
      const associations = [...new Map<string, string>(Object.entries(confFiles.get<object>('associations', {})))]
      console.log(`[${EXTENSION_NAME}] associations : ${associations.length}\n[${associations.join('],[')}]`)
      return (filepath: string) => {
        const lineCounter = this.lineCounterTable.getByPath(filepath)
        if (lineCounter !== undefined) {
          return lineCounter
        }
        const patType = associations.find(([pattern]) => minimatch(filepath, pattern, { matchBase: true }))
        //console.log(`## ${filepath}: ${patType}`);
        return patType !== undefined ? this.lineCounterTable.getByName(patType[1]) : undefined
      }
    })()

    excludes.push(outputDir)
    if (this.getConf('useFilesExclude', true)) {
      excludes.push(...Object.keys(confFiles.get<object>('exclude', {})))
    }
    excludes.push('.gitignore')
    const encoding = confFiles.get('encoding', 'utf8')
    const endOfLine = this.getConf('endOfLine', '\n')
    // console.log(`[${EXTENSION_NAME}] includes : ${includes.join(',')}`);
    // console.log(`[${EXTENSION_NAME}] excludes : ${excludes.join(',')}`);

    vscode.workspace.findFiles(`{${includes.join(',')}}`, `{${excludes.join(',')}}`).then((files: vscode.Uri[]) => {
      new Promise((resolve: (p: string[]) => void, reject: (reason: string) => void) => {
        const filePathes = files.map(uri => uri.fsPath).filter(p => !path.relative(dir, p).startsWith('..'))
        console.log(`[${EXTENSION_NAME}] target : ${filePathes.length} files`)
        if (this.getConf('useGitignore', true)) {
          vscode.workspace.findFiles('**/.gitignore', '').then((gitignoreFiles: vscode.Uri[]) => {
            gitignoreFiles.forEach(f => console.log(`[${EXTENSION_NAME}] use gitignore : ${f.fsPath}`))
            const gitignores = new Gitignore('').merge(
              ...gitignoreFiles
                .map(uri => uri.fsPath)
                .sort()
                .map(p => new Gitignore(fs.readFileSync(p, 'utf8'), path.dirname(p)))
            )
            resolve(filePathes.filter(p => gitignores.excludes(p)))
          })
        } else {
          resolve(filePathes)
        }
      })
        .then((filePathes: string[]) => {
          console.log(`[${EXTENSION_NAME}] target : ${filePathes.length} files`)
          return new Promise((resolve: (value: ResultTable) => void, reject: (reason: string) => void) => {
            const results = new ResultTable(dir, this.getConf('printNumberWithCommas', true) ? toStringWithCommas : (obj: any) => obj.toString())
            if (filePathes.length <= 0) {
              resolve(results)
            }
            let fileCount = 0
            filePathes.forEach(filepath => {
              const lineCounter = findLineCounter(filepath)
              if (lineCounter !== undefined) {
                fs.readFile(filepath, encoding, (err, data) => {
                  ++fileCount
                  if (err) {
                    this.toOutputChannel(`"${filepath}" Read Error : ${err.message}.`)
                    results.appendEmpty(filepath, '(Read Error)')
                  } else {
                    results.appendResult(filepath, lineCounter.name, lineCounter.count(data))
                  }
                  if (fileCount === filePathes.length) {
                    resolve(results)
                  }
                })
              } else {
                if (!ignoreUnsupportedFile) {
                  results.appendEmpty(filepath, '(Unsupported)')
                }
                ++fileCount
                if (fileCount === filePathes.length) {
                  resolve(results)
                }
              }
            })
          })
        })
        .then((results: ResultTable) => {
          console.log(`[${EXTENSION_NAME}] count ${results.length} files`)
          if (results.length <= 0) {
            vscode.window.showErrorMessage(`[${EXTENSION_NAME}] There was no target file.`)
            return
          }
          const previewType = this.getConf<string>('outputPreviewType', '')
          console.log(`[${EXTENSION_NAME}] OutputDir : ${outputDirPath}`)
          makeDirectories(outputDirPath)
          if (this.getConf('outputAsText', true)) {
            const promise = writeTextFile(path.join(outputDirPath, 'results.txt'), results.toTextLines().join(endOfLine))
            if (previewType === 'text') {
              promise.then(ofilename => showTextFile(ofilename)).catch(err => console.error(err))
            } else {
              promise.catch(err => console.error(err))
            }
          }
          if (this.getConf('outputAsMarkdown', true)) {
            const promise = this.getConf('outputMarkdownSeparately.', true)
              ? writeTextFile(
                  path.join(outputDirPath, 'details.md'),
                  ['# Details', '', ...results.toMarkdownHeaderLines(), '', `[summary](results.md)`, '', ...results.toMarkdownDetailsLines(), '', `[summary](results.md)`].join(endOfLine)
                ).then(ofilename =>
                  writeTextFile(
                    path.join(outputDirPath, 'results.md'),
                    ['# Summary', '', ...results.toMarkdownHeaderLines(), '', `[details](details.md)`, '', ...results.toMarkdownSummaryLines(), '', `[details](details.md)`].join(endOfLine)
                  )
                )
              : writeTextFile(
                  path.join(outputDirPath, 'results.md'),
                  [...results.toMarkdownHeaderLines(), '', ...results.toMarkdownSummaryLines(), '', ...results.toMarkdownDetailsLines()].join(endOfLine)
                )
            if (previewType === 'markdown') {
              promise.then(ofilename => vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(ofilename))).catch(err => console.error(err))
            } else {
              promise.catch(err => console.error(err))
            }
          }
        })
        .catch((reason: string) => {
          vscode.window.showErrorMessage(`[${EXTENSION_NAME}] Error has occurred.`, reason)
        })
    })
  }
  private countFile_(doc: vscode.TextDocument | undefined) {
    if (doc !== undefined) {
      const lineCounter = this.lineCounterTable.getByName(doc.languageId) || this.lineCounterTable.getByPath(doc.uri.fsPath)
      console.log(`[${EXTENSION_NAME}] ${path.basename(doc.uri.fsPath)}: ${JSON.stringify(lineCounter)}`)
      if (lineCounter !== undefined) {
        const result = lineCounter.count(doc.getText())
        // return `Code:${result.code} Comment:${result.comment} Blank:${result.blank} Total:${result.code+result.comment+result.blank}`;
        return `Code:${result.code} Comment:${result.comment} Blank:${result.blank}`
      }
    }
    return `${EXTENSION_NAME}:Unsupported`
  }
  public countFile(doc: vscode.TextDocument | undefined) {
    if (this.statusBarItem !== null) {
      this.statusBarItem.show()
      this.statusBarItem.text = this.countFile_(doc)
    }
  }
  public countCurrentFile() {
    // Get the current text editor
    const editor = vscode.window.activeTextEditor
    if (editor !== undefined) {
      this.countFile(editor.document)
    } else {
      this.countFile(undefined)
    }
  }
}

class LineCounterTable {
  private langIdTable: Map<string, LineCounter>
  private aliasTable: Map<string, LineCounter>
  private fileextRules: Map<string, LineCounter>
  private filenameRules: Map<string, LineCounter>

  constructor(conf: vscode.WorkspaceConfiguration) {
    this.langIdTable = new Map<string, LineCounter>()
    this.aliasTable = new Map<string, LineCounter>()
    this.fileextRules = new Map<string, LineCounter>()
    this.filenameRules = new Map<string, LineCounter>()
    const confJsonTable = new Map<string, object>()

    vscode.extensions.all.forEach(ex => {
      // console.log(JSON.stringify(ex.packageJSON));
      const contributes = ex.packageJSON.contributes
      if (contributes !== undefined) {
        const languages = contributes.languages
        if (languages !== undefined) {
          languages.forEach((lang: any) => {
            const lineCounter = getOrSetFirst(this.langIdTable, lang.id, () => new LineCounter(lang.id))
            lineCounter.addAlias(lang.aliases)
            if (lang.aliases !== undefined && lang.aliases.length > 0) {
              lang.aliases.forEach((alias: string) => {
                this.aliasTable.set(alias, lineCounter)
              })
            }
            const confpath = lang.configuration ? path.join(ex.extensionPath, lang.configuration) : ''
            if (confpath.length > 0) {
              // console.log(`language conf file: ${confpath}`);
              const v = getOrSetFirst(confJsonTable, confpath, () => JSONC.parse(fs.readFileSync(confpath, 'utf8')))
              lineCounter.addCommentRule(v.comments)
            }
            if (lang.extensions !== undefined) {
              ;(lang.extensions as Array<string>).forEach(ex => this.fileextRules.set(ex, lineCounter))
            }
            if (lang.filenames !== undefined) {
              ;(lang.filenames as Array<string>).forEach(ex => this.filenameRules.set(ex, lineCounter))
            }
          })
        }
      }
    })
    class BlockPattern {
      public types: string[] = []
      public patterns: string[][] = []
    }
    conf.get<Array<BlockPattern>>('blockComment', []).forEach(patterns => {
      patterns.types.forEach(t => {
        this.addBlockStringRule(
          t,
          ...patterns.patterns.map(pat => {
            return { begin: pat[0], end: pat[1] }
          })
        )
      })
    })
  }
  public getByName(langName: string) {
    return this.langIdTable.get(langName) || this.aliasTable.get(langName)
  }
  public getByPath(filePath: string) {
    return this.fileextRules.get(filePath) || this.fileextRules.get(path.extname(filePath)) || this.filenameRules.get(path.basename(filePath))
  }
  public addBlockStringRule(id: string, ...tokenPairs: { begin: string; end: string }[]) {
    const lineCounter = this.getByName(id) || this.getByPath(id)
    if (lineCounter) {
      // console.log(`addBlockStringRule("${id}",  ${tokenPairs.map(t => t.begin + t.end).join('|')}) => [${lineCounter.name}]`);
      lineCounter.addBlockStringRule(...tokenPairs)
    }
  }
}

class Result {
  public filename: string
  public language: string
  public errorMessage: string
  public code = 0
  public comment = 0
  public blank = 0
  get total(): number {
    return this.code + this.comment + this.blank
  }
  get rate(): string {
    return ((this.comment / (this.code + this.comment)) * 100).toFixed(2) + '%'
  }
  constructor(filename: string, language: string, errorMessage = '') {
    this.filename = filename
    this.language = language
    this.errorMessage = errorMessage
  }
  public append(value: { code: number; comment: number; blank: number }) {
    this.code += value.code
    this.comment += value.comment
    this.blank += value.blank
    return this
  }
}
class Statistics {
  public name: string
  public files = 0
  public code = 0
  public comment = 0
  public blank = 0
  get total(): number {
    return this.code + this.comment + this.blank
  }
  get rate(): string {
    return ((this.comment / (this.code + this.comment)) * 100).toFixed(2) + '%'
  }
  constructor(name: string) {
    this.name = name
  }
  public append(value: { code: number; comment: number; blank: number }) {
    this.files++
    this.code += value.code
    this.comment += value.comment
    this.blank += value.blank
    return this
  }
}
class MarkdownTableFormatter {
  private dir: string
  private valueToString: (obj: any) => string
  private columnInfo: { title: string; format: string }[]
  constructor(dir: string, valueToString: (obj: any) => string, ...columnInfo: { title: string; format: string }[]) {
    this.dir = dir
    this.valueToString = valueToString
    this.columnInfo = columnInfo
  }
  get lineSeparator() {
    return '| ' + this.columnInfo.map(i => (i.format === 'number' || i.title === 'comment rate' ? '---:' : ':---')).join(' | ') + ' |'
  }
  get headerLines() {
    return ['| ' + this.columnInfo.map(i => i.title).join(' | ') + ' |', this.lineSeparator]
  }
  public line(...data: (string | number | boolean)[]) {
    return (
      '| ' +
      data
        .map((d, i) => (typeof d !== 'string' ? this.valueToString(d) : this.columnInfo[i].format === 'uri' ? `[${d}](../${path.relative(vscode.workspace.rootPath, path.join(this.dir, d))})` : d))
        .join(' | ') +
      ' |'
    )
  }
}
class ResultTable {
  private targetDirPath: string
  private fileResults: Result[] = []
  private dirResultTable = new Map<string, Statistics>()
  private langResultTable = new Map<string, Statistics>()
  private total = new Statistics('Total')
  private valueToString: (obj: any) => string

  constructor(dirpath: string, valueToString = (obj: any) => obj.toString()) {
    this.targetDirPath = dirpath
    this.valueToString = valueToString
  }
  public get length() {
    return this.fileResults.length
  }

  public appendResult(filepath: string, language: string, value: { code: number; comment: number; blank: number }) {
    const result = new Result(path.relative(this.targetDirPath, filepath), language).append(value)
    this.fileResults.push(result)
    let parent = path.dirname(result.filename)
    while (parent.length > 0) {
      getOrSetFirst(this.dirResultTable, parent, () => new Statistics(parent)).append(value)
      const p = path.dirname(parent)
      if (p === parent) {
        break
      }
      parent = p
    }
    getOrSetFirst(this.langResultTable, language, () => new Statistics(language)).append(value)
    this.total.append(value)
  }
  public appendError(filepath: string, language: string, err: NodeJS.ErrnoException) {
    this.fileResults.push(new Result(path.relative(this.targetDirPath, filepath), language, 'Error:' + err.message))
  }
  public appendEmpty(filepath: string, language: string) {
    this.fileResults.push(new Result(path.relative(this.targetDirPath, filepath), language))
  }
  public toTextLines() {
    class TextTableFormatter {
      private valueToString: (obj: any) => string
      private columnInfo: { title: string; width: number }[]
      constructor(valueToString: (obj: any) => string, ...columnInfo: { title: string; width: number }[]) {
        this.valueToString = valueToString
        this.columnInfo = columnInfo
        for (const info of this.columnInfo) {
          info.width = Math.max(info.title.length, info.width)
        }
      }
      public get lineSeparator() {
        return '+-' + this.columnInfo.map(i => '-'.repeat(i.width)).join('-+-') + '-+'
      }
      get headerLines() {
        return [this.lineSeparator, '| ' + this.columnInfo.map(i => i.title.padEnd(i.width)).join(' | ') + ' |', this.lineSeparator]
      }
      get footerLines() {
        return [this.lineSeparator]
      }
      public line(...data: (string | number | boolean)[]) {
        return (
          '| ' +
          data
            .map((d, i) => {
              const curItem = this.columnInfo[i]
              if (typeof d === 'string' && curItem.title !== 'comment rate') {
                return d.padEnd(curItem.width)
              } else {
                return this.valueToString(d).padStart(curItem.width)
              }
            })
            .join(' | ') +
          ' |'
        )
      }
    }
    const maxNamelen = Math.max(...this.fileResults.map(res => res.filename.length))
    const maxLanglen = Math.max(...[...this.langResultTable.keys()].map(l => l.length))
    const resultFormat = new TextTableFormatter(
      this.valueToString,
      { title: 'filename', width: maxNamelen },
      { title: 'language', width: maxLanglen },
      { title: 'code', width: 10 },
      { title: 'comment', width: 10 },
      { title: 'blank', width: 10 },
      { title: 'total', width: 10 },
      { title: 'comment rate', width: 10 }
    )
    const dirFormat = new TextTableFormatter(
      this.valueToString,
      { title: 'path', width: maxNamelen },
      { title: 'files', width: 10 },
      { title: 'code', width: 10 },
      { title: 'comment', width: 10 },
      { title: 'blank', width: 10 },
      { title: 'total', width: 10 },
      { title: 'comment rate', width: 10 }
    )
    const langFormat = new TextTableFormatter(
      this.valueToString,
      { title: 'language', width: maxLanglen },
      { title: 'files', width: 10 },
      { title: 'code', width: 10 },
      { title: 'comment', width: 10 },
      { title: 'blank', width: 10 },
      { title: 'total', width: 10 },
      { title: 'comment rate', width: 10 }
    )
    return [
      // '='.repeat(resultFormat.headerLines[0].length),
      // EXTENSION_NAME,
      `Date : ${dateToString(new Date())}`,
      `Directory : ./${path.relative(vscode.workspace.rootPath, this.targetDirPath)}`,
      // `Total : code: ${this.total.code}, comment : ${this.total.comment}, blank : ${this.total.blank}, all ${this.total.total} lines`,
      `Total : ${this.total.files} files,  ${this.total.code} codes, ${this.total.comment} comments, ${this.total.blank} blanks, all ${this.total.total} lines, ${this.total.rate} comment rate`,
      '',
      'Languages',
      ...langFormat.headerLines,
      ...[...this.langResultTable.values()].sort((a, b) => b.code - a.code).map(v => langFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total, v.rate)),
      ...langFormat.footerLines,
      '',
      'Directories',
      ...dirFormat.headerLines,
      ...[...this.dirResultTable.values()].sort((a, b) => b.code - a.code).map(v => dirFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total, v.rate)),
      ...dirFormat.footerLines,
      '',
      'Files',
      ...resultFormat.headerLines,
      ...this.fileResults
        .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
        .map(v => resultFormat.line(v.filename, v.language, v.code, v.comment, v.blank, v.total, v.rate)),
      resultFormat.line('Total', '', this.total.code, this.total.comment, this.total.blank, this.total.total, this.total.rate),
      ...resultFormat.footerLines
    ]
  }

  public toMarkdownHeaderLines() {
    return [
      `Date : ${dateToString(new Date())}`,
      '',
      `Directory : ./${path.relative(vscode.workspace.rootPath, this.targetDirPath)}`,
      '',
      `Total : ${this.total.files} files,  ${this.total.code} codes, ${this.total.comment} comments, ${this.total.blank} blanks, all ${this.total.total} lines, ${this.total.rate} comment rate`
    ]
  }
  public toMarkdownSummaryLines() {
    const dirFormat = new MarkdownTableFormatter(
      this.targetDirPath,
      this.valueToString,
      { title: 'path', format: 'string' },
      { title: 'files', format: 'number' },
      { title: 'code', format: 'number' },
      { title: 'comment', format: 'number' },
      { title: 'blank', format: 'number' },
      { title: 'total', format: 'number' },
      { title: 'comment rate', format: 'string' }
    )
    const langFormat = new MarkdownTableFormatter(
      this.targetDirPath,
      this.valueToString,
      { title: 'language', format: 'string' },
      { title: 'files', format: 'number' },
      { title: 'code', format: 'number' },
      { title: 'comment', format: 'number' },
      { title: 'blank', format: 'number' },
      { title: 'total', format: 'number' },
      { title: 'comment rate', format: 'string' }
    )
    return [
      '## Languages',
      ...langFormat.headerLines,
      ...[...this.langResultTable.values()].sort((a, b) => b.code - a.code).map(v => langFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total, v.rate)),
      '',
      '## Directories',
      ...dirFormat.headerLines,
      // ...[...dirResultTable.values()].sort((a,b) => b.code - a.code)
      ...[...this.dirResultTable.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(v => dirFormat.line(v.name, v.files, v.code, v.comment, v.blank, v.total, v.rate))
    ]
  }
  public toMarkdownDetailsLines() {
    const resultFormat = new MarkdownTableFormatter(
      this.targetDirPath,
      this.valueToString,
      { title: 'filename', format: 'uri' },
      { title: 'language', format: 'string' },
      { title: 'code', format: 'number' },
      { title: 'comment', format: 'number' },
      { title: 'blank', format: 'number' },
      { title: 'total', format: 'number' },
      { title: 'comment rate', format: 'string' }
    )
    return [
      '## Files',
      ...resultFormat.headerLines,
      ...this.fileResults
        .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
        .map(v => resultFormat.line(v.filename, v.language, v.code, v.comment, v.blank, v.total, v.rate))
    ]
  }
}

function getOrSetFirst<K, V>(map: Map<K, V>, key: K, otherwise: () => V) {
  let v = map.get(key)
  if (v === undefined) {
    v = otherwise()
    map.set(key, v)
  }
  return v
}
function makeDirectories(dirpath: string) {
  if (fs.existsSync(dirpath)) {
    return true
  }
  const parent = path.dirname(dirpath)
  if (parent !== dirpath && makeDirectories(parent)) {
    fs.mkdirSync(dirpath)
    return true
  } else {
    return false
  }
}
function showTextFile(outputFilename: string) {
  console.log(`[${EXTENSION_NAME}] showTextFile : ${outputFilename}`)
  return new Promise((resolve: (editor: vscode.TextEditor) => void, reject: (err: any) => void) => {
    vscode.workspace
      .openTextDocument(outputFilename)
      .then(
        doc => {
          return vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true)
        },
        err => {
          reject(err)
        }
      )
      .then(
        editor => {
          resolve(editor)
        },
        err => {
          reject(err)
        }
      )
  })
}
function writeTextFile(outputFilename: string, text: string) {
  console.log(`[${EXTENSION_NAME}] writeTextFile : ${outputFilename} ${text.length}B`)
  return new Promise((resolve: (filename: string) => void, reject: (err: NodeJS.ErrnoException) => void) => {
    fs.writeFile(outputFilename, text, err => {
      if (err) {
        reject(err)
      } else {
        resolve(outputFilename)
      }
    })
  })
}
