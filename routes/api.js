var async = require('async');
var armrest = require('armrest');
var Deferrals = require('../lib/deferrals');
var Item = require('../lib/item');
var api = require('../lib/api.js');
var Sort = require('../lib/sort');
var clone = require('../lib/clone');

var Collection = require('../lib/collection.js');
var EXAMPLE_LENGTH = 1500;

exports.initialize = function(app) {

	var models = app.dreamer.models;
	var workspaceLoader = app.showcase.middleware.workspaceLoader;

	app.post('/api/:workspace_handle/:collection_handle', workspaceLoader, function*(req, res) {

		var workspace = req.showcase.workspace;
		var status = req.body._status;
		var collection_name = req.params.collection_handle;
		var data = req.body;
		var user_id = api.user.id;

		var collection = yield Collection.load({ name: collection_name, workspace_handle: workspace.handle });

		if (!collection) return res.json(404, {
			message: "couldn't find collection",
			code: "no_collection_found"
		});

		var item = yield Item.build({
			collection_id: collection.id,
			status: status,
			data: data,
			user_id: user_id
		});

		if (!item) return res.json(404, {
			message: "couldn't find item",
			code: "no_item_found"
		});

		var errors = item.validate();

		if (errors) return res.json(400, {
			message: "validation failed",
			code: "validation_failed",
			errors: errors
		});

		yield item.save({ user_id: user_id });

		res.json(201, Item.distill(item));
	});

	app.get('/api/:workspace_handle/:collection_handle/:item_id', workspaceLoader, function*(req, res) {

		var workspace = req.showcase.workspace;
		var item_id = req.params.item_id;

		var criteria = resolveCriteria(item_id);
		var item = yield Item.load(criteria);

		if (!item) {
			return res.json(404, {
				message: "couldn't find item",
				code: "no_item_found"
			});
		}

		var distilled_item = Item.distill(item);

		res.json(200, distilled_item);
	});

	app.delete('/api/:workspace_handle/:collection_handle/:item_id', workspaceLoader, function*(req, res) {

		var workspace = req.showcase.workspace;
		var item_id = req.params.item_id;

		var criteria = resolveCriteria(item_id);
		var item = yield Item.load(criteria);

		if (!item) return res.json(404, {
			message: "couldn't find item",
			code: "no_item_found"
		});

		yield item.destroy();
		res.send(204);
	});

	var patchItem = function*(req, res) {

		var workspace = req.showcase.workspace;
		var item_id = req.params.item_id;
		var status = req.body._status;
		var data = req.body;
		var user_id = api.user.id;

		var criteria = resolveCriteria(item_id);
		var item = yield Item.load(criteria);

		if (!item) return res.json(404, {
			message: "couldn't find item",
			code: "no_item_found"
		});

		item.update({
			status: status,
			data: req.body,
			user_id: user_id,
		});

		var errors = item.validate();

		if (errors) return res.json(400, {
			message: "validation failed",
			code: "validation_failed",
			errors: errors
		});

		yield item.save({ user_id: user_id });

		res.json(Item.distill(item));
	};

	app.patch('/api/:workspace_handle/:collection_handle/:item_id', workspaceLoader, patchItem);
	app.post('/api/:workspace_handle/:collection_handle/:item_id', workspaceLoader, patchItem);

	app.get('/api/:workspace_handle/:collection_handle', workspaceLoader, function*(req, res) {

		var name = req.params.collection_handle;
		var per_page = req.query.per_page || 40;
		var page = req.query.page || 0;
		var collection, items;
		var workspace = req.showcase.workspace;
		var sort = Sort.deserialize(req.query.sort);
		var search = req.query.q;

		var collection = yield Collection.load({ name: name, workspace_handle: workspace.handle });

		if (!collection) return res.json(404, {
			message: "couldn't find collection",
			code: "no_collection_found"
		});

		var criteria = {};

		collection.fields.forEach(function(field) {
			if (field.name in req.query) {
				criteria[field.name] = req.query[field.name];
			}
		});
		var standard_fields = ['status', 'id'];
		standard_fields.forEach(function(field) {
			if (field in req.query) {
				criteria[field] = req.query[field];
			}
		});

		var items = yield Item.all({
			collection_id: collection.id,
			criteria: criteria,
			sort: sort,
			page: page,
			per_page: per_page,
			search: search
		});

		items.forEach(function(item) {
			item.collection = collection;
		});

		var distilled_items = [];

		items.forEach(function(item) {
			distilled_items.push(Item.distill(item));
		});

		var total_count = items.totalCount;
		var range_start = (items.page - 1) * items.per_page;
		var range_end = range_start + distilled_items.length - 1;

		var content_range = "items " + range_start + "-" + range_end + "/" + total_count;

		res.header('Content-Range', content_range);
		res.json(distilled_items);
	});

	app.get('api/workspaces/:workspace_handle', workspaceLoader, function* (req, res) {

		var workspace = req.showcase.workspace;
		var api = armrest.client("localhost:" + app.get('port'));

		var collections = yield Collection.all({ workspace_handle: workspace.handle });

		res.json(collections);
	});

	app.get('/workspaces/:workspace_handle/api', workspaceLoader, function* (req, res) {

		var workspace = req.showcase.workspace;
		var api = armrest.client("localhost:" + app.get('port'));

		var collections = yield Collection.all({ workspace_handle: workspace.handle });

		var collection_resources = [];

		async.forEach(collections, function(collection, cb) {

			var route = '/api/' + workspace.handle + '/' + collection.name;

			api.get({
				url: route,
				params: { per_page: 1 },
				success: function(items, response) {

					var resource = { collection: collection };

					var example_response = response.body;
					if (example_response && example_response.length > EXAMPLE_LENGTH) {
						example_response = example_response.substring(0, EXAMPLE_LENGTH) + '...';
					}

					if (response.body !== '[]') {
						resource.example_listing_response = example_response;
					}

					collection_resources.push(resource);
					cb();
				}
			});

		}, function() {

			collection_resources = collection_resources
				.sort(function(a, b) { return a.collection.title.localeCompare(b.collection.title); });

			res.render("api.html", { collection_resources: collection_resources });
		});
	});

	app.get('/api/:workspace_handle', workspaceLoader, function*(req, res) {

		var workspace = clone(req.showcase.workspace);
		delete workspace.id;

		var collections = yield Collection.all({ workspace_handle: workspace.handle });

		collections.forEach(function(collection) {
			delete collection.id;
			delete collection.workspace_handle;
			collection.fields.forEach(function(field) {
				delete field.id;
				delete field.collection_id;
				delete field.index;
				delete field.meta;
			});
		});

		workspace.collections = collections;
		res.json(workspace);
	});
};

function resolveCriteria(identifier) {

	var criteria = {};
	var field = identifier.match(/[a-z]/) ? 'key' : 'id';
	criteria[field] = identifier;

	return criteria;
};
