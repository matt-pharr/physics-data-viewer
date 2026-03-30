"""
pdv-python/tests/test_handlers_namespace.py — Tests for namespace handlers.
"""

import math
import uuid
from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest

import pdv_kernel.comms as comms_mod
from pdv_kernel.handlers.namespace import handle_namespace_inspect, handle_namespace_query


def _make_mock_comm():
    sent = []
    mock_comm = MagicMock()
    mock_comm.send.side_effect = lambda data: sent.append(data)
    mock_comm._sent = sent
    return mock_comm


def _make_msg(payload=None, msg_id=None):
    return {
        'pdv_version': comms_mod.PDV_PROTOCOL_VERSION,
        'msg_id': msg_id or str(uuid.uuid4()),
        'in_reply_to': None,
        'type': 'pdv.namespace.query',
        'payload': payload or {},
    }


def _make_inspect_msg(payload=None, msg_id=None):
    return {
        'pdv_version': comms_mod.PDV_PROTOCOL_VERSION,
        'msg_id': msg_id or str(uuid.uuid4()),
        'in_reply_to': None,
        'type': 'pdv.namespace.inspect',
        'payload': payload or {},
    }


class TestHandleNamespaceQuery:
    def test_query_default_filters_returns_user_vars(self):
        ip = MagicMock()
        ip.user_ns = {
            'visible': 7,
            '_private': 8,
            'module_ref': math,
            'fn': lambda x: x,
            'pdv_tree': object(),
            'pdv': object(),
        }
        mock_comm = _make_mock_comm()
        msg = _make_msg()
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', ip):
            handle_namespace_query(msg)

        response = mock_comm._sent[0]
        assert response['type'] == 'pdv.namespace.query.response'
        variables = response['payload']['variables']
        assert 'visible' in variables
        assert '_private' not in variables
        assert 'module_ref' not in variables
        assert 'fn' not in variables
        assert 'pdv_tree' not in variables
        assert 'pdv' not in variables

    def test_query_include_private_includes_private_vars(self):
        ip = MagicMock()
        ip.user_ns = {'_private': 123}
        mock_comm = _make_mock_comm()
        msg = _make_msg({'include_private': True})
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', ip):
            handle_namespace_query(msg)

        variables = mock_comm._sent[0]['payload']['variables']
        assert '_private' in variables

    def test_query_excludes_pdv_tree_and_pdv(self):
        ip = MagicMock()
        ip.user_ns = {'pdv_tree': object(), 'pdv': object(), 'value': 1}
        mock_comm = _make_mock_comm()
        msg = _make_msg({'include_private': True, 'include_modules': True, 'include_callables': True})
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', ip):
            handle_namespace_query(msg)

        variables = mock_comm._sent[0]['payload']['variables']
        assert 'pdv_tree' not in variables
        assert 'pdv' not in variables
        assert 'value' in variables

    def test_query_no_kernel_returns_empty_variables(self):
        mock_comm = _make_mock_comm()
        msg = _make_msg()
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', None):
            handle_namespace_query(msg)

        response = mock_comm._sent[0]
        assert response['status'] == 'ok'
        assert response['payload']['variables'] == {}

    def test_query_with_numpy_array_includes_type_info(self):
        numpy = pytest.importorskip('numpy')
        ip = MagicMock()
        ip.user_ns = {'arr': numpy.array([[1, 2], [3, 4]], dtype=numpy.int64)}
        mock_comm = _make_mock_comm()
        msg = _make_msg()
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', ip):
            handle_namespace_query(msg)

        arr_desc = mock_comm._sent[0]['payload']['variables']['arr']
        assert arr_desc['type'] == 'ndarray'
        assert arr_desc['kind'] == 'ndarray'
        assert arr_desc['shape'] == [2, 2]
        assert 'int64' in arr_desc['dtype']


class TestHandleNamespaceInspect:
    def test_inspect_array_returns_index_children(self):
        numpy = pytest.importorskip('numpy')
        ip = MagicMock()
        ip.user_ns = {'arr': numpy.array([1, 2, 3])}
        mock_comm = _make_mock_comm()
        msg = _make_inspect_msg({'root_name': 'arr', 'path': []})
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', ip):
            handle_namespace_inspect(msg)

        response = mock_comm._sent[0]
        assert response['type'] == 'pdv.namespace.inspect.response'
        children = response['payload']['children']
        assert children[0]['name'] == '[0]'
        assert children[0]['expression'] == 'arr[0]'

    def test_inspect_object_returns_attribute_children(self):
        @dataclass
        class Sample:
            alpha: int
            beta: int

        ip = MagicMock()
        ip.user_ns = {'sample': Sample(alpha=1, beta=2)}
        mock_comm = _make_mock_comm()
        msg = _make_inspect_msg({'root_name': 'sample', 'path': []})
        with patch.object(comms_mod, '_comm', mock_comm), patch.object(comms_mod, '_ip', ip):
            handle_namespace_inspect(msg)

        children = mock_comm._sent[0]['payload']['children']
        assert {child['name'] for child in children} == {'alpha', 'beta'}
