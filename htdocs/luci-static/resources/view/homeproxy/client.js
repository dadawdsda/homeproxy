/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Copyright (C) 2022-2023 ImmortalWrt.org
 */

'use strict';
'require form';
'require fs';
'require network';
'require poll';
'require rpc';
'require uci';
'require ui';
'require validation';
'require view';

'require homeproxy as hp';
'require tools.firewall as fwtool';
'require tools.widgets as widgets';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

var callReadDomainList = rpc.declare({
	object: 'luci.homeproxy',
	method: 'acllist_read',
	params: ['type'],
	expect: { '': {} }
});

var callWriteDomainList = rpc.declare({
	object: 'luci.homeproxy',
	method: 'acllist_write',
	params: ['type', 'content'],
	expect: { '': {} }
});

var callGetAPISecret = rpc.declare({
	object: 'luci.homeproxy',
	method: 'clash_api_get_secret',
	params: [],
	expect: { '': {} }
});

var callResVersion = rpc.declare({
	object: 'luci.homeproxy',
	method: 'resources_get_version',
	params: ['type', 'repo'],
	expect: { '': {} }
});

function getServiceStatus() {
	return L.resolveDefault(callServiceList('homeproxy'), {}).then((res) => {
		var isRunning = false;
		try {
			isRunning = res['homeproxy']['instances']['sing-box-c']['running'];
		} catch (e) { }
		return isRunning;
	});
}

function renderStatus(isRunning, args) {
	let nginx = args.features.hp_has_nginx && args.nginx_support === '1';
	var spanTemp = '<em><span style="color:%s"><strong>%s %s</strong></span></em>';
	var urlParams;
	var renderHTML;
	if (isRunning) {
		if (args.set_dash_backend) {
			switch (args.dashboard_repo) {
				case 'metacubex/metacubexd':
					urlParams = String.format('#/setup?hostname=%s&port=%s&secret=%s', window.location.hostname, args.api_port, args.api_secret);
					break;
				case 'metacubex/yacd-meta':
					urlParams = String.format('?hostname=%s&port=%s&secret=%s', window.location.hostname, args.api_port, args.api_secret);
					break;
				case 'metacubex/razord-meta':
					urlParams = String.format('?host=%s&port=%s&secret=%s', window.location.hostname, args.api_port, args.api_secret);
					break;
				case 'Zephyruso/zashboard':
					urlParams = String.format('#/setup?hostname=%s&port=%s&secret=%s', window.location.hostname, args.api_port, args.api_secret);
					break;
				default:
					break;
			}
		}
		if (args.dashboard_repo) {
			var button = String.format('&#160;<a class="btn cbi-button-apply" href="%s" target="_blank" rel="noreferrer noopener">%s</a>',
				(nginx ? 'https:' : 'http:') + '//' + window.location.hostname +
				(nginx ? '/homeproxy' : ':' + args.api_port) + '/ui/' + (urlParams || ''),
				_('Open Clash Dashboard'));
		}
		renderHTML = spanTemp.format('green', _('HomeProxy'), _('RUNNING')) + (button || '');
	} else
		renderHTML = spanTemp.format('red', _('HomeProxy'), _('NOT RUNNING'));

	return renderHTML;
}

function validatePortRange(section_id, value) {
	if (section_id && value) {
		value = value.match(/^(\d+)?\:(\d+)?$/);
		if (value && (value[1] || value[2])) {
			if (!value[1])
				value[1] = 0;
			else if (!value[2])
				value[2] = 65535;

			if (value[1] < value[2] && value[2] <= 65535)
				return true;
		}

		return _('Expecting: %s').format( _('valid port range (port1:port2)'));
	}

	return true;
}

var stubValidator = {
	factory: validation,
	apply: function(type, value, args) {
		if (value != null)
			this.value = value;

		return validation.types[type].apply(this, args);
	},
	assert: function(condition) {
		return !!condition;
	}
};

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('homeproxy'),
			hp.getBuiltinFeatures(),
			network.getHostHints(),
			L.resolveDefault(callGetAPISecret(), {})
		]);
	},

	render: function(data) {
		var m, s, o, ss, so;

		var features = data[1],
		    hosts = data[2]?.hosts,
			api_port = uci.get(data[0], 'experimental', 'clash_api_port'),
			api_secret = data[3]?.secret || '',
			nginx_support = uci.get(data[0], 'experimental', 'nginx_support') || '0',
			dashboard_repo = uci.get(data[0], 'experimental', 'dashboard_repo'),
			set_dash_backend = uci.get(data[0], 'experimental', 'set_dash_backend');

		m = new form.Map('homeproxy', _('HomeProxy'),
			_('The modern ImmortalWrt proxy platform for ARM64/AMD64.'));

		s = m.section(form.TypedSection);
		s.render = function () {
			poll.add(function () {
				return L.resolveDefault(getServiceStatus()).then((res) => {
					var view = document.getElementById('service_status');
					view.innerHTML = renderStatus(res, {features, nginx_support, dashboard_repo, set_dash_backend, api_port, api_secret});
				});
			});

			return E('div', { class: 'cbi-section', id: 'status_bar' }, [
					E('p', { id: 'service_status' }, _('Collecting data...'))
			]);
		}

		/* Cache all subscription info, they will be called multiple times */
		var subs_info = hp.loadSubscriptionInfo(data[0]);

		/* Cache all configured proxy nodes, they will be called multiple times */
		var proxy_nodes = hp.loadNodesList(data[0], subs_info);

		s = m.section(form.NamedSection, 'config', 'homeproxy');

		s.tab('routing', _('Routing Settings'));

		o = s.taboption('routing', form.ListValue, 'main_node', _('Main node'));
		o.value('nil', _('Disable'));
		for (var k in proxy_nodes)
			o.value(k, proxy_nodes[k]);
		o.default = 'nil';
		o.depends({'routing_mode': 'custom', '!reverse': true});
		o.rmempty = false;

		o = s.taboption('routing', form.ListValue, 'main_udp_node', _('Main UDP node'));
		o.value('nil', _('Disable'));
		o.value('same', _('Same as main node'));
		for (var k in proxy_nodes)
			o.value(k, proxy_nodes[k]);
		o.default = 'nil';
		o.depends({'routing_mode': /^((?!custom).)+$/, 'proxy_mode': /^((?!redirect$).)+$/});
		o.rmempty = false;

		o = s.taboption('routing', form.Value, 'dns_server', _('DNS server'),
			_('It MUST support TCP query.'));
		o.value('wan', _('WAN DNS (read from interface)'));
		o.value('1.1.1.1', _('CloudFlare Public DNS (1.1.1.1)'));
		o.value('208.67.222.222', _('Cisco Public DNS (208.67.222.222)'));
		o.value('8.8.8.8', _('Google Public DNS (8.8.8.8)'));
		o.value('', '---');
		o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
		o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
		o.value('114.114.114.114', _('Xinfeng Public DNS (114.114.114.114)'));
		o.default = '8.8.8.8';
		o.rmempty = false;
		o.depends({'routing_mode': 'custom', '!reverse': true});
		o.validate = function(section_id, value) {
			if (section_id && !['wan'].includes(value)) {
				var ipv6_support = this.map.lookupOption('ipv6_support', section_id)[0].formvalue(section_id);

				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));
				else if (!stubValidator.apply((ipv6_support === '1') ? 'ipaddr' : 'ip4addr', value))
					return _('Expecting: %s').format(_('valid IP address'));
			}

			return true;
		}

		if (features.hp_has_chinadns_ng) {
			o = s.taboption('routing', form.DynamicList, 'china_dns_server', _('China DNS server'));
			o.value('wan', _('WAN DNS (read from interface)'));
			o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
			o.value('210.2.4.8', _('CNNIC Public DNS (210.2.4.8)'));
			o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
			o.value('114.114.114.114', _('Xinfeng Public DNS (114.114.114.114)'));
			o.depends('routing_mode', 'bypass_mainland_china');
			o.validate = function(section_id) {
				if (section_id) {
					var value = this.map.lookupOption('china_dns_server', section_id)[0].formvalue(section_id);
					if (value.length < 1)
						return true;

					if (!features.hp_has_chinadns_ng_v2 && value.length > 2)
						return _('You can only have two servers set at maximum.');

					for (var dns of value) {
						var ipv6_support = this.map.lookupOption('ipv6_support', section_id)[0].formvalue(section_id);
						if (dns === 'wan') {
							continue;
						} else {
							var err = _('Expecting: %s').format(_('valid address#port'));
							dns = dns.split('#');
							if (dns.length > 2)
								return err;
							if (!stubValidator.apply((ipv6_support === '1') ? 'ipaddr' : 'ip4addr', dns[0]))
								return err;
							if (dns[1] && !stubValidator.apply('port', dns[1]))
								return err;
						}
					}
				}

				return true;
			}
		}

		o = s.taboption('routing', form.ListValue, 'routing_mode', _('Routing mode'));
		o.value('gfwlist', _('GFWList'));
		o.value('bypass_mainland_china', _('Bypass mainland China'));
		o.value('proxy_mainland_china', _('Only proxy mainland China'));
		o.value('custom', _('Custom routing'));
		o.value('global', _('Global'));
		o.default = 'bypass_mainland_china';
		o.rmempty = false;
		o.onchange = function(ev, section_id, value) {
			if (section_id && value === 'custom')
				this.map.save(null, true);
		}

		o = s.taboption('routing', form.Value, 'routing_port', _('Routing ports'),
			_('Specify target ports to be proxied. Multiple ports must be separated by commas.'));
		o.value('all', _('All ports'));
		o.value('common', _('Common ports only (bypass P2P traffic)'));
		o.default = 'common';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (section_id && value !== 'all' && value !== 'common') {
				if (!value)
					return _('Expecting: %s').format(_('valid port value'));

				var ports = [];
				for (var i of value.split(',')) {
					if (!stubValidator.apply('port', i) && !stubValidator.apply('portrange', i))
						return _('Expecting: %s').format(_('valid port value'));
					if (ports.includes(i))
						return _('Port %s alrealy exists!').format(i);
					ports = ports.concat(i);
				}
			}

			return true;
		}

		o = s.taboption('routing', form.ListValue, 'proxy_mode', _('Proxy mode'));
		o.value('redirect', _('Redirect TCP'));
		if (features.hp_has_tproxy)
			o.value('redirect_tproxy', _('Redirect TCP + TProxy UDP'));
		if (features.hp_has_ip_full && features.hp_has_tun) {
			o.value('redirect_tun', _('Redirect TCP + Tun UDP'));
			o.value('tun', _('Tun TCP/UDP'));
		} else {
			o.description = _('To enable Tun support, you need to install <code>ip-full</code> and <code>kmod-tun</code>');
		}
		o.default = 'redirect_tproxy';
		o.rmempty = false;

		o = s.taboption('routing', form.Flag, 'ipv6_support', _('IPv6 support'));
		o.default = o.enabled;
		o.rmempty = false;

		/* Custom routing settings start */
		/* Routing settings start */
		o = s.taboption('routing', form.SectionValue, '_routing', form.NamedSection, 'routing', 'homeproxy');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		so = ss.option(form.Flag, 'tun_gso', _('Generic segmentation offload'));
		so.default = so.disabled;
		so.depends('homeproxy.config.proxy_mode', 'redirect_tun');
		so.depends('homeproxy.config.proxy_mode', 'tun');
		so.rmempty = false;

		so = ss.option(form.ListValue, 'tcpip_stack', _('TCP/IP stack'),
			_('TCP/IP stack.'));
		if (features.with_gvisor) {
			so.value('mixed', _('Mixed'));
			so.value('gvisor', _('gVisor'));
		}
		so.value('system', _('System'));
		so.default = 'system';
		so.depends('homeproxy.config.proxy_mode', 'redirect_tun');
		so.depends('homeproxy.config.proxy_mode', 'tun');
		so.rmempty = false;
		so.onchange = function(ev, section_id, value) {
			var desc = ev.target.nextElementSibling;
			if (value === 'mixed')
				desc.innerHTML = _('Mixed <code>system</code> TCP stack and <code>gVisor</code> UDP stack.')
			else if (value === 'gvisor')
				desc.innerHTML = _('Based on google/gvisor.');
			else if (value === 'system')
				desc.innerHTML = _('Less compatibility and sometimes better performance.');
		}

		so = ss.option(form.Flag, 'endpoint_independent_nat', _('Enable endpoint-independent NAT'),
			_('Performance may degrade slightly, so it is not recommended to enable on when it is not needed.'));
		so.default = so.enabled;
		so.depends('tcpip_stack', 'mixed');
		so.depends('tcpip_stack', 'gvisor');
		so.rmempty = false;

		so = ss.option(form.Value, 'udp_timeout', _('UDP NAT expiration time'),
			_('In seconds. <code>300</code> is used by default.'));
		so.datatype = 'uinteger';
		so.default = '300';
		so.depends('homeproxy.config.proxy_mode', 'redirect_tproxy');
		so.depends('homeproxy.config.proxy_mode', 'redirect_tun');
		so.depends('homeproxy.config.proxy_mode', 'tun');
		so.rmempty = false;

		so = ss.option(form.Flag, 'bypass_cn_traffic', _('Bypass CN traffic'),
			_('Bypass mainland China traffic via firewall rules by default.'));
		so.default = so.disabled;
		so.rmempty = false;

		so = ss.option(form.Flag, 'sniff_override', _('Override destination'),
			_('Override the connection destination address with the sniffed domain.'));
		so.default = so.enabled;
		so.rmempty = false;

		so = ss.option(form.ListValue, 'default_outbound', _('Default outbound'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('nil', _('Disable'));
			this.value('direct-out', _('Direct'));
			this.value('block-out', _('Block'));
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'nil';
		so.rmempty = false;

		so = ss.option(form.Button, '_reload_client', _('Quick Reload'));
		so.inputtitle = _('Reload');
		so.inputstyle = 'apply';
		so.onclick = function() {
			return fs.exec('/etc/init.d/homeproxy', ['reload', 'client'])
				.then((res) => { return window.location = window.location.href.split('#')[0] })
				.catch((e) => {
					ui.addNotification(null, E('p', _('Failed to execute "/etc/init.d/homeproxy %s %s" reason: %s').format('reload', 'client', e)));
				});
		};
		/* Routing settings end */

		/* Routing nodes start */
		s.tab('routing_node', _('Routing Nodes'));
		o = s.taboption('routing_node', form.SectionValue, '_routing_node', form.GridSection, 'routing_node');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('Routing node'), _('Add a routing node'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss, {}, true);
		ss.handleAdd = L.bind(hp.handleAdd, this, ss, {});

		so = ss.option(form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'routing_node', 'label');
		so.modalonly = true;

		so = ss.option(form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.ListValue, 'node', _('Node'),
			_('Outbound node'));
		for (var k in proxy_nodes)
			so.value(k, proxy_nodes[k]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'routing_node', 'node');
		so.editable = true;

		so = ss.option(form.ListValue, 'domain_strategy', _('Domain strategy'),
			_('If set, the server domain name will be resolved to IP before connecting.<br/>dns.strategy will be used if empty.'));
		for (var i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);
		so.modalonly = true;

		so = ss.option(widgets.DeviceSelect, 'bind_interface', _('Bind interface'),
			_('The network interface to bind to.'));
		so.multiple = false;
		so.noaliases = true;
		so.depends('outbound', '');
		so.modalonly = true;

		so = ss.option(form.ListValue, 'outbound', _('Outbound'),
			_('The tag of the upstream outbound.<br/>Other dial fields will be ignored when enabled.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('Direct'));
			uci.sections(data[0], 'routing_node', (res) => {
				if (res['.name'] !== section_id && res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.validate = function(section_id, value) {
			if (section_id && value) {
				var node = this.map.lookupOption('node', section_id)[0].formvalue(section_id);

				var conflict = false;
				uci.sections(data[0], 'routing_node', (res) => {
					if (res['.name'] !== section_id)
						if (res.outbound === section_id && res['.name'] == value)
							conflict = true;
				});
				if (conflict)
					return _('Recursive outbound detected!');
			}

			return true;
		}
		/* Routing nodes end */

		/* Routing rules start */
		s.tab('routing_rule', _('Routing Rules'));
		o = s.taboption('routing_rule', form.SectionValue, '_routing_rule', form.GridSection, 'routing_rule');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		var prefmt = { 'prefix': '', 'suffix': '_host' };
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('Routing rule'), _('Add a routing rule'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss, prefmt, false);
		ss.handleAdd = L.bind(hp.handleAdd, this, ss, prefmt);

		ss.tab('field_other', _('Other fields'));
		ss.tab('field_host', _('Host fields'));
		ss.tab('field_port', _('Port fields'));
		ss.tab('field_source_ip', _('SRC-IP fields'));
		ss.tab('field_source_port', _('SRC-Port fields'));

		so = ss.taboption('field_other', form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'routing_rule', 'label');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.ListValue, 'mode', _('Mode'),
			_('The default rule uses the following matching logic:<br/>' +
			'<code>(domain || domain_suffix || domain_keyword || domain_regex || ip_cidr || ip_is_private)</code> &&<br/>' +
			'<code>(port || port_range)</code> &&<br/>' +
			'<code>(source_ip_cidr || source_ip_is_private)</code> &&<br/>' +
			'<code>(source_port || source_port_range)</code> &&<br/>' +
			'<code>other fields</code>.<br/>' +
			'Additionally, included rule sets can be considered merged rather than as a single rule sub-item.'));
		so.value('default', _('Default'));
		so.default = 'default';
		so.rmempty = false;
		so.readonly = true;

		so = ss.taboption('field_other', form.ListValue, 'ip_version', _('IP version'),
			_('4 or 6. Not limited if empty.'));
		so.value('4', _('IPv4'));
		so.value('6', _('IPv6'));
		so.value('', _('Both'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.MultiValue, 'protocol', _('Protocol'),
			_('Sniffed protocol, see <a target="_blank" href="https://sing-box.sagernet.org/configuration/route/sniff/">Sniff</a> for details.'));
		so.value('http', _('HTTP'));
		so.value('tls', _('TLS'));
		so.value('quic', _('QUIC'));
		so.value('stun', _('STUN'));

		so = ss.taboption('field_other', form.ListValue, 'network', _('Network'));
		so.value('tcp', _('TCP'));
		so.value('udp', _('UDP'));
		so.value('', _('Both'));

		so = ss.taboption('field_host', form.DynamicList, 'domain', _('Domain name'),
			_('Match full domain.'));
		so.datatype = 'hostname';
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_suffix', _('Domain suffix'),
			_('Match domain suffix.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_keyword', _('Domain keyword'),
			_('Match domain using keyword.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_regex', _('Domain regex'),
			_('Match domain using regular expression.'));
		so.modalonly = true;

		so = ss.taboption('field_source_ip', form.DynamicList, 'source_ip_cidr', _('Source IP CIDR'),
			_('Match source IP CIDR.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_source_ip', form.Flag, 'source_ip_is_private', _('Private source IP'),
			_('Match private source IP.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'ip_cidr', _('IP CIDR'),
			_('Match IP CIDR.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_host', form.Flag, 'ip_is_private', _('Private IP'),
			_('Match private IP.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_source_port', form.DynamicList, 'source_port', _('Source port'),
			_('Match source port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_source_port', form.DynamicList, 'source_port_range', _('Source port range'),
			_('Match source port range. Format as START:/:END/START:END.'));
		so.validate = validatePortRange;
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port', _('Port'),
			_('Match port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port_range', _('Port range'),
			_('Match port range. Format as START:/:END/START:END.'));
		so.validate = validatePortRange;
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'process_name', _('Process name'),
			_('Match process name.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'process_path', _('Process path'),
			_('Match process path.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'user', _('User'),
			_('Match user name.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'clash_mode', _('Clash mode'),
			_('Match clash mode.'));
		so.value('', _('None'));
		so.value('global', _('Global'));
		so.value('rule', _('Rule'));
		so.value('direct', _('Direct'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.MultiValue, 'rule_set', _('Rule set'),
			_('Match rule set.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('-- Please choose --'));
			uci.sections(data[0], 'ruleset', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'rule_set_ipcidr_match_source', _('Match source IP via rule set'),
			_('Make IP CIDR in rule set used to match the source IP.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'invert', _('Invert'),
			_('Invert match result.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'outbound', _('Outbound'),
			_('Tag of the target outbound.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('direct-out', _('Direct'));
			this.value('block-out', _('Block'));
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.rmempty = false;
		so.editable = true;
		/* Routing rules end */

		/* DNS settings start */
		s.tab('dns', _('DNS Settings'));
		o = s.taboption('dns', form.SectionValue, '_dns', form.NamedSection, 'dns', 'homeproxy');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		so = ss.option(form.ListValue, 'default_strategy', _('Default DNS strategy'),
			_('The DNS strategy for resolving the domain name in the address.'));
		for (var i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);

		so = ss.option(form.ListValue, 'default_server', _('Default DNS server'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			this.value('block-dns', _('Block DNS queries'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'default-dns';
		so.rmempty = false;

		so = ss.option(form.Flag, 'disable_cache', _('Disable DNS cache'));
		so.default = so.disabled;

		so = ss.option(form.Flag, 'disable_cache_expire', _('Disable cache expire'));
		so.default = so.disabled;
		so.depends('disable_cache', '0');

		so = ss.option(form.Flag, 'independent_cache', _('Independent cache per server'),
			_('Make each DNS server\'s cache independent for special purposes. If enabled, will slightly degrade performance.'));
		so.default = so.disabled;
		so.depends('disable_cache', '0');

		so = ss.option(form.Value, 'client_subnet', _('EDNS Client subnet'),
			_('Append a <code>edns0-subnet</code> OPT extra record with the specified IP prefix to every query by default.<br/>' +
			'If value is an IP address instead of prefix, <code>/32</code> or <code>/128</code> will be appended automatically.'));
		so.datatype = 'or(cidr, ipaddr)';

		so = ss.option(form.Flag, 'cache_file_store_rdrc', _('Store RDRC'),
			_('Store rejected DNS response cache.<br/>' +
			'The check results of <code>Address filter DNS rule items</code> will be cached until expiration.'));
		so.ucisection = 'experimental';
		so.default = so.disabled;

		so = ss.option(form.Value, 'cache_file_rdrc_timeout', _('RDRC timeout'),
			_('Timeout of rejected DNS response cache. <code>7d</code> is used by default.'));
		so.ucisection = 'experimental';
		so.depends('cache_file_store_rdrc', '1');
		/* DNS settings end */

		/* DNS servers start */
		s.tab('dns_server', _('DNS Servers'));
		o = s.taboption('dns_server', form.SectionValue, '_dns_server', form.GridSection, 'dns_server');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		var prefmt = { 'prefix': 'dns_', 'suffix': '' };
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('DNS server'), _('Add a DNS server'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss, prefmt, true);
		ss.handleAdd = L.bind(hp.handleAdd, this, ss, prefmt);

		so = ss.option(form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'dns_server', 'label');
		so.modalonly = true;

		so = ss.option(form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.Value, 'address', _('Address'),
			_('The address of the dns server. Support UDP, TCP, DoT, DoH and RCode.'));
		so.rmempty = false;

		so = ss.option(form.ListValue, 'address_resolver', _('Address resolver'),
			_('Tag of a another server to resolve the domain name in the address. Required if address contains domain.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('None'));
			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res['.name'] !== section_id && res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.validate = function(section_id, value) {
			if (section_id && value) {
				var conflict = false;
				uci.sections(data[0], 'dns_server', (res) => {
					if (res['.name'] !== section_id)
						if (res.address_resolver === section_id && res['.name'] == value)
							conflict = true;
				});
				if (conflict)
					return _('Recursive resolver detected!');
			}

			return true;
		}
		so.modalonly = true;

		so = ss.option(form.ListValue, 'address_strategy', _('Address strategy'),
			_('The domain strategy for resolving the domain name in the address. dns.strategy will be used if empty.'));
		for (var i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);
		so.modalonly = true;

		so = ss.option(form.ListValue, 'resolve_strategy', _('Resolve strategy'),
			_('Default domain strategy for resolving the domain names.'));
		for (var i in hp.dns_strategy)
			so.value(i, hp.dns_strategy[i]);

		so = ss.option(form.ListValue, 'outbound', _('Outbound'),
			_('Tag of an outbound for connecting to the dns server.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('direct-out', _('Direct'));
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.default = 'direct-out';
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.Value, 'client_subnet', _('EDNS Client subnet'),
			_('Append a <code>edns0-subnet</code> OPT extra record with the specified IP prefix to every query by default.<br/>' +
			'If value is an IP address instead of prefix, <code>/32</code> or <code>/128</code> will be appended automatically.'));
		so.datatype = 'or(cidr, ipaddr)';
		/* DNS servers end */

		/* DNS rules start */
		s.tab('dns_rule', _('DNS Rules'));
		o = s.taboption('dns_rule', form.SectionValue, '_dns_rule', form.GridSection, 'dns_rule');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		var prefmt = { 'prefix': '', 'suffix': '_domain' };
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('DNS rule'), _('Add a DNS rule'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss, prefmt, false);
		ss.handleAdd = L.bind(hp.handleAdd, this, ss, prefmt);

		ss.tab('field_other', _('Other fields'));
		ss.tab('field_host', _('Host fields'));
		ss.tab('field_port', _('Port fields'));
		ss.tab('field_source_ip', _('SRC-IP fields'));
		ss.tab('field_source_port', _('SRC-Port fields'));

		so = ss.taboption('field_other', form.Value, 'label', _('Label'));
		so.load = L.bind(hp.loadDefaultLabel, this, data[0]);
		so.validate = L.bind(hp.validateUniqueValue, this, data[0], 'dns_rule', 'label');
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.ListValue, 'mode', _('Mode'),
			_('The default rule uses the following matching logic:<br/>' +
			'<code>(domain || domain_suffix || domain_keyword || domain_regex)</code> &&<br/>' +
			'<code>(port || port_range)</code> &&<br/>' +
			'<code>(source_ip_cidr || source_ip_is_private)</code> &&<br/>' +
			'<code>(source_port || source_port_range)</code> &&<br/>' +
			'<code>other fields</code>.<br/>' +
			'Additionally, included rule sets can be considered merged rather than as a single rule sub-item.'));
		so.value('default', _('Default'));
		so.default = 'default';
		so.rmempty = false;
		so.readonly = true;

		so = ss.taboption('field_other', form.ListValue, 'ip_version', _('IP version'));
		so.value('4', _('IPv4'));
		so.value('6', _('IPv6'));
		so.value('', _('Both'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'query_type', _('Query type'),
			_('Match query type.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'network', _('Network'));
		so.value('tcp', _('TCP'));
		so.value('udp', _('UDP'));
		so.value('', _('Both'));

		so = ss.taboption('field_other', form.MultiValue, 'protocol', _('Protocol'),
			_('Sniffed protocol, see <a target="_blank" href="https://sing-box.sagernet.org/configuration/route/sniff/">Sniff</a> for details.'));
		so.value('http', _('HTTP'));
		so.value('tls', _('TLS'));
		so.value('quic', _('QUIC'));
		so.value('dns', _('DNS'));
		so.value('stun', _('STUN'));

		so = ss.taboption('field_host', form.DynamicList, 'domain', _('Domain name'),
			_('Match full domain.'));
		so.datatype = 'hostname';
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_suffix', _('Domain suffix'),
			_('Match domain suffix.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_keyword', _('Domain keyword'),
			_('Match domain using keyword.'));
		so.modalonly = true;

		so = ss.taboption('field_host', form.DynamicList, 'domain_regex', _('Domain regex'),
			_('Match domain using regular expression.'));
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port', _('Port'),
			_('Match port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_port', form.DynamicList, 'port_range', _('Port range'),
			_('Match port range. Format as START:/:END/START:END.'));
		so.validate = validatePortRange;
		so.modalonly = true;

		so = ss.taboption('field_source_ip', form.DynamicList, 'source_ip_cidr', _('Source IP CIDR'),
			_('Match source IP CIDR.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_source_ip', form.Flag, 'source_ip_is_private', _('Private source IP'),
			_('Match private source IP.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'ip_cidr', _('IP CIDR'),
			_('Match IP CIDR with query response.'));
		so.datatype = 'or(cidr, ipaddr)';
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'ip_is_private', _('Private IP'),
			_('Match private IP with query response.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_source_port', form.DynamicList, 'source_port', _('Source port'),
			_('Match source port.'));
		so.datatype = 'port';
		so.modalonly = true;

		so = ss.taboption('field_source_port', form.DynamicList, 'source_port_range', _('Source port range'),
			_('Match source port range. Format as START:/:END/START:END.'));
		so.validate = validatePortRange;
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'process_name', _('Process name'),
			_('Match process name.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'process_path', _('Process path'),
			_('Match process path.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.DynamicList, 'user', _('User'),
			_('Match user name.'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'clash_mode', _('Clash mode'),
			_('Match clash mode.'));
		so.value('', _('None'));
		so.value('global', _('Global'));
		so.value('rule', _('Rule'));
		so.value('direct', _('Direct'));
		so.modalonly = true;

		so = ss.taboption('field_other', form.MultiValue, 'rule_set', _('Rule set'),
			_('Match rule set.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('', _('-- Please choose --'));
			uci.sections(data[0], 'ruleset', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'rule_set_ipcidr_match_source', _('Rule set IP CIDR as source IP'),
			_('Make <code>ipcidr</code> in rule sets match the source IP.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_other', form.Flag, 'invert', _('Invert'),
			_('Invert match result.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_other', form.MultiValue, 'outbound', _('Outbound'),
			_('Match <code>.outbounds[].server</code> domains.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('any-out', _('Any'));
			this.value('direct-out', _('Direct'));
			this.value('block-out', _('Block'));
			uci.sections(data[0], 'routing_node', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.validate = function(section_id, value) {
			let arr = value.trim().split(' ');
			if (arr.length > 1 && arr.includes('any-out'))
				return _('Expecting: %s').format(_('If Any is selected, uncheck others'));

			return true;
		}
		so.modalonly = true;

		so = ss.taboption('field_other', form.ListValue, 'server', _('Server'),
			_('Tag of the target dns server.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			this.value('default-dns', _('Default DNS (issued by WAN)'));
			this.value('system-dns', _('System DNS'));
			this.value('block-dns', _('Block DNS queries'));
			uci.sections(data[0], 'dns_server', (res) => {
				if (res.enabled === '1')
					this.value(res['.name'], res.label);
			});

			return this.super('load', section_id);
		}
		so.rmempty = false;
		so.editable = true;

		so = ss.taboption('field_other', form.Flag, 'dns_disable_cache', _('Disable dns cache'),
			_('Disable cache and save cache in this query.'));
		so.default = so.disabled;
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'rewrite_ttl', _('Rewrite TTL'),
			_('Rewrite TTL in DNS responses.'));
		so.datatype = 'uinteger';
		so.modalonly = true;

		so = ss.taboption('field_other', form.Value, 'client_subnet', _('EDNS Client subnet'),
			_('Append a <code>edns0-subnet</code> OPT extra record with the specified IP prefix to every query by default.<br/>' +
			'If value is an IP address instead of prefix, <code>/32</code> or <code>/128</code> will be appended automatically.'));
		so.datatype = 'or(cidr, ipaddr)';
		/* DNS rules end */
		/* Custom routing settings end */

		/* Clash API settings start */
		s.tab('clash', _('Clash API settings'));
		o = s.taboption('clash', form.SectionValue, '_clash', form.NamedSection, 'experimental');
		o.depends('routing_mode', 'custom');

		ss = o.subsection;
		so = ss.option(form.Flag, 'clash_api_enabled', _('Enable Clash API'));
		so.default = so.disabled;

		so = ss.option(form.Flag, 'nginx_support', _('Nginx Support'));
		so.rmempty = true;
		if (! features.hp_has_nginx) {
			so.description = _('To enable this feature you need install <b>luci-nginx</b> and <b>luci-ssl-nginx</b><br/> first');
			so.readonly = true;
		}
		so.write = function(section_id, value) {
			return uci.set(data[0], section_id, 'nginx_support', features.hp_has_nginx ? value : null);
		}

		so = ss.option(form.ListValue, 'clash_api_log_level', _('Log level'));
		so.value('trace', 'Trace');
		so.value('debug', 'Debug');
		so.value('info', 'Info');
		so.value('warn', 'Warning');
		so.value('error', 'Error');
		so.value('fatal', 'Fatal');
		so.value('panic', 'Panic');
		so.default = 'warn';

		so = ss.option(form.ListValue, 'dashboard_repo', _('Select Clash Dashboard'),
			_('If the selected dashboard is <code>') + _('Not Installed') + _('</code>.<br/> you will need to check update via <code>') +
			_('Service Status') + _('</code> » <code>') + _('Clash dashboard version') + _('</code>.'));
		so.load = function(section_id) {
			delete this.keylist;
			delete this.vallist;

			let repos = [
				['metacubex/metacubexd', _('metacubexd')],
				['metacubex/yacd-meta', _('yacd-meta')],
				['metacubex/razord-meta', _('razord-meta')],
				['Zephyruso/zashboard',_('zashboard')]
			];

			this.value('', _('Use Online Dashboard'));
			repos.forEach((repo) => {
				callResVersion('clash_dashboard', repo[0]).then((res) => {
					this.value(repo[0], repo[1] + ' - ' + (res.error ? _('Not Installed') : _('Installed')));
				});
			});

			return this.super('load', section_id);
		}
		so.default = '';
		if (api_secret) {
			if (features.hp_has_nginx && nginx_support === '1') {
				so.description = _('The current API URL is <code>%s</code>')
					.format('https://' + window.location.hostname + '/homeproxy/');
			} else {
				so.description = _('The current API URL is <code>%s</code>')
					.format('http://' + window.location.hostname + ':' + api_port);
			}
		}

		so = ss.option(form.Flag, 'set_dash_backend', _('Auto set backend'),
			_('Auto set backend address for dashboard.'));
		so.default = so.disabled;

		so = ss.option(form.Value, 'clash_api_port', _('Port'));
		so.datatype = "and(port, min(1))";
		so.default = '9090';
		so.rmempty = false;

		so = ss.option(form.Value, 'clash_api_secret', _('Secret'), _('Automatically generated if empty'));
		so.password = true;
		if (api_secret)
			so.description = _('The current Secret is <code>' + api_secret + '</code>');
		/* Clash API settings end */

		/* ACL settings start */
		s.tab('control', _('Access Control'));

		o = s.taboption('control', form.SectionValue, '_control', form.NamedSection, 'control', 'homeproxy');
		ss = o.subsection;

		/* Interface control start */
		ss.tab('interface', _('Interface Control'));

		so = ss.taboption('interface', widgets.DeviceSelect, 'listen_interfaces', _('Listen interfaces'),
			_('Only process traffic from specific interfaces. Leave empty for all.'));
		so.multiple = true;
		so.noaliases = true;

		so = ss.taboption('interface', widgets.DeviceSelect, 'bind_interface', _('Bind interface'),
			_('Bind outbound traffic to specific interface. Leave empty to auto detect.'));
		so.multiple = false;
		so.noaliases = true;
		/* Interface control end */

		/* LAN IP policy start */
		ss.tab('lan_ip_policy', _('LAN IP Policy'));

		so = ss.taboption('lan_ip_policy', form.ListValue, 'lan_proxy_mode', _('Proxy filter mode'));
		so.value('disabled', _('Disable'));
		so.value('listed_only', _('Proxy listed only'));
		so.value('except_listed', _('Proxy all except listed'));
		so.default = 'disabled';
		so.rmempty = false;

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_direct_ipv4_ips', _('Direct IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends('lan_proxy_mode', 'except_listed');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_direct_ipv6_ips', _('Direct IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'lan_proxy_mode': 'except_listed', 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_direct_mac_addrs', _('Direct MAC-s'), null, hosts);
		so.depends('lan_proxy_mode', 'except_listed');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_proxy_ipv4_ips', _('Proxy IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends('lan_proxy_mode', 'listed_only');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_proxy_ipv6_ips', _('Proxy IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'lan_proxy_mode': 'listed_only', 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_proxy_mac_addrs', _('Proxy MAC-s'), null, hosts);
		so.depends('lan_proxy_mode', 'listed_only');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_gaming_mode_ipv4_ips', _('Gaming mode IPv4 IP-s'), null, 'ipv4', hosts, true);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_gaming_mode_ipv6_ips', _('Gaming mode IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends('homeproxy.config.ipv6_support', '1');

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_gaming_mode_mac_addrs', _('Gaming mode MAC-s'), null, hosts);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_global_proxy_ipv4_ips', _('Global proxy IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends({'homeproxy.config.routing_mode': 'custom', '!reverse': true});

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_global_proxy_ipv6_ips', _('Global proxy IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'homeproxy.config.routing_mode': /^((?!custom).)+$/, 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_global_proxy_mac_addrs', _('Global proxy MAC-s'), null, hosts);
		so.depends({'homeproxy.config.routing_mode': 'custom', '!reverse': true});
		/* LAN IP policy end */

		/* WAN IP policy start */
		ss.tab('wan_ip_policy', _('WAN IP Policy'));

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_proxy_ipv4_ips', _('Proxy IPv4 IP-s'));
		so.datatype = 'or(ip4addr, cidr4)';

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_proxy_ipv6_ips', _('Proxy IPv6 IP-s'));
		so.datatype = 'or(ip6addr, cidr6)';
		so.depends('homeproxy.config.ipv6_support', '1');

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_direct_ipv4_ips', _('Direct IPv4 IP-s'));
		so.datatype = 'or(ip4addr, cidr4)';

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_direct_ipv6_ips', _('Direct IPv6 IP-s'));
		so.datatype = 'or(ip6addr, cidr6)';
		so.depends('homeproxy.config.ipv6_support', '1');
		/* WAN IP policy end */

		/* Proxy domain list start */
		ss.tab('proxy_domain_list', _('Proxy Domain List'));

		so = ss.taboption('proxy_domain_list', form.TextValue, '_proxy_domain_list');
		so.rows = 10;
		so.monospace = true;
		so.datatype = 'hostname';
		so.depends({'homeproxy.config.routing_mode': 'custom', '!reverse': true});
		so.load = function(section_id) {
			return L.resolveDefault(callReadDomainList('proxy_list')).then((res) => {
				return res.content;
			}, {});
		}
		so.write = function(section_id, value) {
			return callWriteDomainList('proxy_list', value);
		}
		so.remove = function(section_id, value) {
			return callWriteDomainList('proxy_list', '');
		}
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (var i of value.split('\n'))
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));

			return true;
		}
		/* Proxy domain list end */

		/* Direct domain list start */
		ss.tab('direct_domain_list', _('Direct Domain List'));

		so = ss.taboption('direct_domain_list', form.TextValue, '_direct_domain_list');
		so.rows = 10;
		so.monospace = true;
		so.datatype = 'hostname';
		so.depends({'homeproxy.config.routing_mode': 'custom', '!reverse': true});
		so.load = function(section_id) {
			return L.resolveDefault(callReadDomainList('direct_list')).then((res) => {
				return res.content;
			}, {});
		}
		so.write = function(section_id, value) {
			return callWriteDomainList('direct_list', value);
		}
		so.remove = function(section_id, value) {
			return callWriteDomainList('direct_list', '');
		}
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (var i of value.split('\n'))
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));

			return true;
		}
		/* Direct domain list end */
		/* ACL settings end */

		return m.render();
	}
});
