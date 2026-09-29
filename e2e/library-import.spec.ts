import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

test.describe('document library', () => {
  test('opened files are copied into the library; edits save to the copy and the original stays untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-library-'))
    const mdPath = join(dir, 'note.md')
    await writeFile(mdPath, '# Original\n')

    const launched = await launchShell({
      onboardingSeen: true,
      settings: { libraryAutoImport: true },
      videoDir: 'library-import',
      openFile: mdPath,
    })
    const { app, page, userDataDir } = launched
    try {
      const editorPage = await waitForPageWithUrl(app, '://markdown/')
      await expect(editorPage.locator('.doc-editor h1')).toHaveText('Original')

      // edit and save: the write must land on the library copy, not the original
      await editorPage.locator('.doc-editor').focus()
      await editorPage.keyboard.press('ControlOrMeta+End')
      await editorPage.keyboard.press('Enter')
      await editorPage.keyboard.type('Edited in the library.')
      await editorPage.keyboard.press('ControlOrMeta+s')
      await expect(editorPage.locator('.status-save')).toHaveText(/Saved/)

      expect(await readFile(mdPath, 'utf8')).toBe('# Original\n')

      const index = JSON.parse(await readFile(join(userDataDir, 'library.json'), 'utf8'))
      expect(index.entries).toHaveLength(1)
      expect(index.entries[0].originalPath.replace(/\\/g, '/')).toBe(mdPath.replace(/\\/g, '/'))
      expect(await readFile(index.entries[0].libPath, 'utf8')).toContain('Edited in the library.')

      // the home Library section lists the copy with its original location,
      // and re-opening it from there resolves to the same copy (no second import)
      await page.locator('.tab-bar .tab-home').click()
      await page.locator('.nav-item', { hasText: 'Library' }).click()
      const row = page.locator('.recent-row', { hasText: 'note.md' })
      await expect(row).toHaveCount(1)
      await expect(row.locator('.recent-path')).toContainText(dir)
      await row.click()
      await waitForPageWithUrl(app, '://markdown/')
      const reread = JSON.parse(await readFile(join(userDataDir, 'library.json'), 'utf8'))
      expect(reread.entries).toHaveLength(1)
      expect(reread.entries[0].libPath).toBe(index.entries[0].libPath)
    } finally {
      await closeAndSaveVideo(launched, 'library-import')
    }
  })

  test('libraryAutoImport: false keeps the classic in-place save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-nolibrary-'))
    const mdPath = join(dir, 'note.md')
    await writeFile(mdPath, '# In place\n')

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'library-off',
      openFile: mdPath,
    })
    const { app, userDataDir } = launched
    try {
      const editorPage = await waitForPageWithUrl(app, '://markdown/')
      await editorPage.locator('.doc-editor').focus()
      await editorPage.keyboard.press('ControlOrMeta+End')
      await editorPage.keyboard.press('Enter')
      await editorPage.keyboard.type('Saved in place.')
      await editorPage.keyboard.press('ControlOrMeta+s')
      await expect(editorPage.locator('.status-save')).toHaveText(/Saved/)

      // the edit landed in the original file and no library index exists
      expect(await readFile(mdPath, 'utf8')).toContain('Saved in place.')
      await expect(readFile(join(userDataDir, 'library.json'), 'utf8')).rejects.toThrow()
    } finally {
      await closeAndSaveVideo(launched, 'library-off')
    }
  })
})
