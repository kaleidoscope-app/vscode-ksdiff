import * as vscode from 'vscode';
import { API as GitAPI, GitExtension, Repository } from '../typings/git';
import { spawn, SpawnOptions } from 'child_process';
import simpleGit, { GitError } from 'simple-git';
import { sep } from 'path';

// Private Types Declaration
// https://github.com/Axosoft/vscode-gitlens/blob/main/src/commands/externalDiff.ts#L19-L49

/*eslint-disable */

enum Status { 
	INDEX_MODIFIED, 
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,

	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,

	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED,
}
export const enum ResourceGroupType {
	Merge,
	Index,
	WorkingTree,
	Untracked
}

/*eslint-enable */

interface Resource extends vscode.SourceControlResourceState {
	readonly resourceGroupType: ResourceGroupType;
	readonly type: Status;
}

function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:\\/.test(path);
}

function isDescendant(parent: string, descendant: string): boolean {
	if (parent === descendant) {
		return true;
	}

	if (parent.charAt(parent.length - 1) !== sep) {
		parent += sep;
	}

	// Windows is case insensitive
	if (isWindowsPath(parent)) {
		parent = parent.toLowerCase();
		descendant = descendant.toLowerCase();
	}

	return descendant.startsWith(parent);
}

function git(repository: Repository, gitCommandAndArgs: string[]): void {
	simpleGit(repository.rootUri.fsPath).raw(
		gitCommandAndArgs,
		(err: any, result: any) => {
			if (err && err.message) {
				vscode.window.showWarningMessage(err.message);
			}
		}
	);
}

function difftool(repository: Repository, additionalArgs: string[]): void {
	let config = vscode.workspace.getConfiguration('kaleidoscope');
	let tool = config.get('git.difftool') as string;
	if (tool === 'Kaleidoscope') {
		git(repository, ['difftool', '-y', '--tool=Kaleidoscope', ...additionalArgs]);
	} else {
		git(repository, ['difftool', '-y', ...additionalArgs]);
	}
}

function mergetool(repository: Repository, additionalArgs: string[]): void {
	let config = vscode.workspace.getConfiguration('kaleidoscope');
	let tool = config.get('git.mergetool') as string;
	if (tool === 'Kaleidoscope') {
		git(repository, ['mergetool', '-y', '--tool=Kaleidoscope', ...additionalArgs]);
	} else {
		git(repository, ['mergetool', '-y', ...additionalArgs]);
	}
}

async function fileExists(path:string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.parse(path));
		return true;
	} catch {
		let selection = await vscode.window.showWarningMessage(`${path} file does *not* exist`, 'More');
		if (selection && selection === 'More' ) {
			vscode.env.openExternal(vscode.Uri.parse('https://kaleidoscope.app'));
		}
		return false;
	}
}

export function activate(context: vscode.ExtensionContext) {
	
	let extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) { 
		return; 
	}
	let gitExtension = extension.exports;
	let gitAPI = gitExtension.getAPI(1);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.diffFile', async (uri: vscode.Uri, uris: [vscode.Uri]) => {
			let config = vscode.workspace.getConfiguration('kaleidoscope');
			let diffPath = config.get('compareTool') as string;
			if (!await fileExists(diffPath)) {
				return;
			}

			var paths;
			if (uris && uris.length > 0) {
				paths = uris.map(r => r.fsPath);
			} else {
				paths = [uri.fsPath];
			}

			let spawnOptions: SpawnOptions;
			spawnOptions = {
				detached: true
			};
			let workspaceName = vscode.workspace.name ?? "VSCode";
			const diff = spawn(diffPath, ['-l', workspaceName, ...paths], spawnOptions);
			diff.stdin?.end();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand('kaleidoscope.diffSection', async (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit) => {
			let config = vscode.workspace.getConfiguration('kaleidoscope');
			let diffPath = config.get('compareTool') as string;
			if (!await fileExists(diffPath)) {
				return;
			}

			const selection = textEditor.selection;
			const text = textEditor.document.getText(selection);

			let spawnOptions: SpawnOptions;
			spawnOptions = {
				detached: true
			};
			let workspaceName = vscode.workspace.name ?? "VSCode";
			const diff = spawn(diffPath, ['-l', workspaceName, '-'], spawnOptions);
			diff.stdin?.write(text);
			diff.stdin?.end();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.diffScm', (...resourceStates: [vscode.SourceControlResourceState]) => {
			if (!resourceStates.length) {
				return;
			}

			let paths = resourceStates.map(r => r.resourceUri.fsPath);
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, paths[0]))[0];

			if (paths.length === 1) {
				if ((resourceStates[0] as Resource).resourceGroupType === ResourceGroupType.Index) {
					difftool(repository, ['--staged', ...paths]);
				} else {
					difftool(repository, paths);
				}
			} else {
				difftool(repository, ['HEAD', ...paths]);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.mergeScm', (...resourceStates: [vscode.SourceControlResourceState]) => {
			if (!resourceStates.length) {
				return;
			}

			let paths = resourceStates.map(r => r.resourceUri.fsPath);
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, paths[0]))[0];

			mergetool(repository, paths);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showAllStagedChanges', (group: vscode.SourceControlResourceGroup) => {
			if (!group.resourceStates.length) {
				return;
			}
			let resourceState = group.resourceStates[0];

			let fullTargetFilePath: string = resourceState.resourceUri.fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, fullTargetFilePath))[0];
	
			difftool(repository, ['--staged']);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showAllUnstagedChanges', (group: vscode.SourceControlResourceGroup) => {
			if (!group.resourceStates.length) {
				return;
			}
			let resourceState = group.resourceStates[0];

			let fullTargetFilePath: string = resourceState.resourceUri.fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, fullTargetFilePath))[0];
	
			difftool(repository, []);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.showChanges', (resourceState: vscode.SourceControlResourceState) => {
			let path: string = resourceState.resourceUri.fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, path))[0];
	
			difftool(repository, [path]);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaleidoscope.textCompareEditor', (uri: vscode.Uri) => {

			let path: string = uri.fsPath;
			let repository = gitAPI.repositories.filter(r => isDescendant(r.rootUri.fsPath, path))[0];
			
			if (uri.scheme === 'merge-conflict.conflict-diff') {
				mergetool(repository, [path]);
			} else {
				difftool(repository, [path]);
			}
		})
	);
	
}

export function deactivate() {}
