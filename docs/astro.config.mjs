// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://nandan-varma.github.io',
	base: '/git-edge',
	integrations: [
		starlight({
			title: 'git-edge',
			description:
			'High-level edge-compatible git operations on top of isomorphic-git: a parsed-object LRU cache, an object-level three-way merge that never needs a worktree, and per-repo packfile-cache management.',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/nandan-varma/git-edge',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/nandan-varma/git-edge/edit/main/docs/',
			},
			customCss: ['./src/styles/custom.css'],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Introduction', slug: 'index' },
						{ label: 'Getting started', slug: 'getting-started' },
						{ label: 'Semantics & limitations', slug: 'semantics-and-limitations' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Three-way merge', slug: 'guides/three-way-merge' },
						{ label: 'Parsed-object cache', slug: 'guides/parsed-object-cache' },
						{ label: 'Repo cache', slug: 'guides/repo-cache' },
					],
				},
				{
					label: 'Reference',
					items: [{ label: 'Root export', slug: 'reference' }],
				},
			],
		}),
	],
});
